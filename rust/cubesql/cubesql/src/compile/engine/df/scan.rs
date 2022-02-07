use std::{
    any::Any,
    fmt,
    sync::Arc,
    task::{Context, Poll},
};

use async_trait::async_trait;
use cubeclient::models::{V1LoadRequestQuery, V1LoadResult};
use datafusion::{
    arrow::{
        array::{ArrayRef, BooleanBuilder, Float64Builder, Int64Builder, StringBuilder},
        datatypes::{DataType, SchemaRef},
        error::Result as ArrowResult,
        record_batch::RecordBatch,
    },
    error::{DataFusionError, Result},
    execution::context::ExecutionContextState,
    logical_plan::{DFSchemaRef, Expr, LogicalPlan, UserDefinedLogicalNode},
    physical_plan::{
        planner::ExtensionPlanner, DisplayFormatType, ExecutionPlan, Partitioning, PhysicalPlanner,
        RecordBatchStream, SendableRecordBatchStream, Statistics,
    },
};
use futures::Stream;
use log::{error, warn};

use crate::{mysql::AuthContext, transport::TransportService};

#[derive(Debug)]
pub struct CubeScanNode {
    pub schema: DFSchemaRef,
    pub request: V1LoadRequestQuery,
    pub auth_context: Arc<AuthContext>,
}

impl CubeScanNode {
    pub fn new(
        schema: DFSchemaRef,
        request: V1LoadRequestQuery,
        auth_context: Arc<AuthContext>,
    ) -> Self {
        Self {
            schema,
            request,
            auth_context,
        }
    }
}

impl UserDefinedLogicalNode for CubeScanNode {
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn inputs(&self) -> Vec<&LogicalPlan> {
        vec![]
    }

    fn schema(&self) -> &DFSchemaRef {
        &self.schema
    }

    fn expressions(&self) -> Vec<Expr> {
        vec![]
    }

    fn fmt_for_explain(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "CubeScan: request={:?}", self.request)
    }

    fn from_template(
        &self,
        exprs: &[datafusion::logical_plan::Expr],
        inputs: &[datafusion::logical_plan::LogicalPlan],
    ) -> std::sync::Arc<dyn UserDefinedLogicalNode + Send + Sync> {
        assert_eq!(inputs.len(), 0, "input size inconsistent");
        assert_eq!(exprs.len(), 0, "expression size inconsistent");

        Arc::new(CubeScanNode {
            schema: self.schema.clone(),
            request: self.request.clone(),
            auth_context: self.auth_context.clone(),
        })
    }
}

//  Produces an execution plan where the schema is mismatched from
//  the logical plan node.
pub struct CubeScanExtensionPlanner {
    pub transport: Arc<dyn TransportService>,
}

impl ExtensionPlanner for CubeScanExtensionPlanner {
    /// Create a physical plan for an extension node
    fn plan_extension(
        &self,
        _planner: &dyn PhysicalPlanner,
        node: &dyn UserDefinedLogicalNode,
        logical_inputs: &[&LogicalPlan],
        physical_inputs: &[Arc<dyn ExecutionPlan>],
        _ctx_state: &ExecutionContextState,
    ) -> Result<Option<Arc<dyn ExecutionPlan>>> {
        Ok(
            if let Some(scan_node) = node.as_any().downcast_ref::<CubeScanNode>() {
                assert_eq!(logical_inputs.len(), 0, "Inconsistent number of inputs");
                assert_eq!(physical_inputs.len(), 0, "Inconsistent number of inputs");

                // figure out input name
                Some(Arc::new(CubeScanExecutionPlan {
                    schema: SchemaRef::new(scan_node.schema().as_ref().into()),
                    transport: self.transport.clone(),
                    request: scan_node.request.clone(),
                    auth_context: scan_node.auth_context.clone(),
                }))
            } else {
                None
            },
        )
    }
}

#[derive(Debug)]
struct CubeScanExecutionPlan {
    schema: SchemaRef,
    request: V1LoadRequestQuery,
    auth_context: Arc<AuthContext>,
    // Shared references
    transport: Arc<dyn TransportService>,
}

impl CubeScanExecutionPlan {
    fn hydrate_response_to_record_batch(&self, response: V1LoadResult) -> Result<RecordBatch> {
        let mut columns = vec![];

        for schema_field in self.schema.fields() {
            let column = match schema_field.data_type() {
                DataType::Utf8 => {
                    let mut builder = StringBuilder::new(100);

                    for row in response.data.iter() {
                        let value = row.as_object().unwrap().get(schema_field.name()).ok_or(
                            DataFusionError::Internal(
                                "Unexpected response from Cube.js, rows are not objects"
                                    .to_string(),
                            ),
                        )?;
                        match &value {
                            serde_json::Value::Null => builder.append_null()?,
                            serde_json::Value::String(v) => builder.append_value(v.clone())?,
                            serde_json::Value::Bool(v) => {
                                builder.append_value(if *v { "true" } else { "false" })?
                            }
                            serde_json::Value::Number(v) => builder.append_value(v.to_string())?,
                            v => {
                                error!(
                                    "Unable to map value {:?} to DataType::Utf8 (returning null)",
                                    v
                                );

                                builder.append_null()?
                            }
                        };
                    }

                    Arc::new(builder.finish()) as ArrayRef
                }
                DataType::Int64 => {
                    let mut builder = Int64Builder::new(100);

                    for row in response.data.iter() {
                        let value = row.as_object().unwrap().get(schema_field.name()).ok_or(
                            DataFusionError::Internal(
                                "Unexpected response from Cube.js, rows are not objects"
                                    .to_string(),
                            ),
                        )?;
                        match &value {
                            serde_json::Value::Null => builder.append_null()?,
                            serde_json::Value::Number(number) => match number.as_i64() {
                                Some(v) => builder.append_value(v)?,
                                None => builder.append_null()?,
                            },
                            serde_json::Value::String(s) => match s.parse::<i64>() {
                                Ok(v) => builder.append_value(v)?,
                                Err(error) => {
                                    warn!("Unable to parse value as i64: {}", error.to_string());

                                    builder.append_null()?
                                }
                            },
                            v => {
                                error!(
                                    "Unable to map value {:?} to DataType::Int64 (returning null)",
                                    v
                                );

                                builder.append_null()?
                            }
                        };
                    }

                    Arc::new(builder.finish()) as ArrayRef
                }
                DataType::Float64 => {
                    let mut builder = Float64Builder::new(100);

                    for row in response.data.iter() {
                        let value = row.as_object().unwrap().get(schema_field.name()).ok_or(
                            DataFusionError::Internal(
                                "Unexpected response from Cube.js, rows are not objects"
                                    .to_string(),
                            ),
                        )?;
                        match &value {
                            serde_json::Value::Null => builder.append_null()?,
                            serde_json::Value::Number(number) => match number.as_f64() {
                                Some(v) => builder.append_value(v)?,
                                None => builder.append_null()?,
                            },
                            serde_json::Value::String(s) => match s.parse::<f64>() {
                                Ok(v) => builder.append_value(v)?,
                                Err(error) => {
                                    warn!("Unable to parse value as f64: {}", error.to_string());

                                    builder.append_null()?
                                }
                            },
                            v => {
                                error!(
                                    "Unable to map value {:?} to DataType::Float64 (returning null)",
                                    v
                                );

                                builder.append_null()?
                            }
                        };
                    }

                    Arc::new(builder.finish()) as ArrayRef
                }
                DataType::Boolean => {
                    let mut builder = BooleanBuilder::new(100);

                    for row in response.data.iter() {
                        let value = row.as_object().unwrap().get(schema_field.name()).ok_or(
                            DataFusionError::Internal(
                                "Unexpected response from Cube.js, rows are not objects"
                                    .to_string(),
                            ),
                        )?;
                        match &value {
                            serde_json::Value::Null => builder.append_null()?,
                            serde_json::Value::Bool(v) => builder.append_value(*v)?,
                            v => {
                                error!(
                                    "Unable to map value {:?} to DataType::Boolean (returning null)",
                                    v
                                );

                                builder.append_null()?
                            }
                        };
                    }

                    Arc::new(builder.finish()) as ArrayRef
                }
                t => {
                    return Err(DataFusionError::NotImplemented(format!(
                        "Type {} is not supported in response hydration from Cube.js",
                        t,
                    )))
                }
            };

            columns.push(column);
        }

        Ok(RecordBatch::try_new(self.schema.clone(), columns)?)
    }
}

#[async_trait]
impl ExecutionPlan for CubeScanExecutionPlan {
    /// Return a reference to Any that can be used for downcasting
    fn as_any(&self) -> &dyn Any {
        self
    }

    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn output_partitioning(&self) -> Partitioning {
        Partitioning::UnknownPartitioning(1)
    }

    fn children(&self) -> Vec<Arc<dyn ExecutionPlan>> {
        vec![]
    }

    fn with_new_children(
        &self,
        _children: Vec<Arc<dyn ExecutionPlan>>,
    ) -> Result<Arc<dyn ExecutionPlan>> {
        Err(DataFusionError::Internal(format!(
            "Children cannot be replaced in {:?}",
            self
        )))
    }

    async fn execute(&self, _partition: usize) -> Result<SendableRecordBatchStream> {
        let result = self
            .transport
            .load(self.request.clone(), self.auth_context.clone())
            .await;

        let response = result.map_err(|err| DataFusionError::Execution(err.to_string()))?;

        let result = if response.results.len() > 0 {
            response.results[0].clone()
        } else {
            return Err(DataFusionError::Execution(format!(
                "Unable to extract result from Cube.js response",
            )));
        };

        Ok(Box::pin(CubeScanMemoryStream::new(
            // @todo Pagination?)
            vec![self.hydrate_response_to_record_batch(result)?],
            self.schema.clone(),
        )))
    }

    fn fmt_as(&self, t: DisplayFormatType, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match t {
            DisplayFormatType::Default => {
                write!(f, "CubeScanExecutionPlan")
            }
        }
    }

    fn statistics(&self) -> Statistics {
        unimplemented!("CubeScanExecutionPlan::statistics");
    }
}

struct CubeScanMemoryStream {
    /// Vector of record batches
    data: Vec<RecordBatch>,
    /// Schema representing the data
    schema: SchemaRef,
    /// Index into the data
    index: usize,
}

impl CubeScanMemoryStream {
    pub fn new(data: Vec<RecordBatch>, schema: SchemaRef) -> Self {
        Self {
            data,
            schema,
            index: 0,
        }
    }
}

impl Stream for CubeScanMemoryStream {
    type Item = ArrowResult<RecordBatch>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        Poll::Ready(if self.index < self.data.len() {
            self.index += 1;
            let batch = &self.data[self.index - 1];

            Some(Ok(batch.clone()))
        } else {
            None
        })
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.data.len(), Some(self.data.len()))
    }
}

impl RecordBatchStream for CubeScanMemoryStream {
    /// Get the schema
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
}
