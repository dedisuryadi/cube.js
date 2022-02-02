// eslint-disable-next-line import/no-extraneous-dependencies
import { expect } from '@jest/globals';
import { DriverInterface, PreAggregations } from "@cubejs-backend/query-orchestrator";
import { streamToArray } from "@cubejs-backend/shared";
import { v4 } from "uuid";
import fetch from "node-fetch";
import { gunzipSync } from "zlib";
import dedent from "dedent";
import dotenv from "@cubejs-backend/dotenv";

export class DriverTests {
  public constructor(
    private readonly driver: DriverInterface
  ) {
  }

  public static config() {
    if ('CUBEJS_TEST_ENV' in process.env) {
      dotenv.config({ path: process.env.CUBEJS_TEST_ENV });
    }
  }

  public release(): Promise<void> {
    return this.driver.release();
  }

  public readonly QUERY = `
    SELECT id, amount, status
    FROM (
      SELECT 1 AS id, 100 AS amount, 'new' AS status
      UNION ALL
      SELECT 2 AS id, 200 AS amount, 'new' AS status
      UNION ALL
      SELECT 3 AS id, 400 AS amount, 'processed' AS status
    )
    ORDER BY 1
  `;

  public async testQuery() {
    const data = await this.driver.query(this.QUERY, []);
    expect(data).toEqual([
      { id: 1, amount: 100, status: 'new' },
      { id: 2, amount: 200, status: 'new' },
      { id: 3, amount: 400, status: 'processed' },
    ]);
  }

  public async testStream() {
    expect(this.driver.stream).toBeDefined();
    const tableData = await this.driver.stream!(this.QUERY, [], { highWaterMark: 100 });
    expect(tableData.types).toEqual(123);
    expect(await streamToArray(tableData.rowStream)).toEqual([
      { id: 1, amount: 100, status: 'new' },
      { id: 2, amount: 200, status: 'new' },
      { id: 3, amount: 400, status: 'processed' },
    ]);
  }

  public async testUnload() {
    expect(this.driver.unload).toBeDefined();
    const versionEntry = {
      table_name: 'test_pre_aggregations.orders_order_status',
      structure_version: v4(),
      content_version: v4(),
      last_updated_at: 160000000000,
      naming_version: 2
    };
    const tableName = PreAggregations.targetTableName(versionEntry);
    await this.driver.loadPreAggregationIntoTable(
      tableName,
      `
        SELECT orders.status AS orders__status, sum(orders.amount) AS orders__amount        
        FROM (${this.QUERY}) AS orders
        GROUP BY 1
        ORDER BY 1
      `,
      [],
      {
        newVersionEntry: versionEntry,
        targetTableName: tableName,
      }
    );
    const data = await this.driver.unload!(tableName, { maxFileSize: 64 });
    expect(data.csvFile.length).toEqual(1);
    const response = await fetch(data.csvFile[0]);
    const gz = await response.arrayBuffer();
    const bytes = await gunzipSync(gz);
    const string = bytes.toString();
    expect(string.trim()).toEqual(dedent`
      orders__status,orders__amount
      new,300
      processed,400
    `);
  }
}