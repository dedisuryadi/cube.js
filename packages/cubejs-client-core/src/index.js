import { v4 as uuidv4 } from 'uuid';
import ResultSet from './ResultSet';
import SqlQuery from './SqlQuery';
import Meta from './Meta';
import ProgressResult from './ProgressResult';
import HttpTransport from './HttpTransport';
import RequestError from './RequestError';

let mutexCounter = 0;

const MUTEX_ERROR = 'Mutex has been changed';

function mutexPromise(promise) {
  return new Promise(async (resolve, reject) => {
    try {
      resolve(await promise);
    } catch (error) {
      if (error !== MUTEX_ERROR) {
        reject(error);
      }
    }
  });
}

class CubejsApi {
  constructor(apiToken, options) {
    if (apiToken !== null && !Array.isArray(apiToken) && typeof apiToken === 'object') {
      options = apiToken;
      apiToken = undefined;
    }
    options = options || {};

    if (!options.transport && !options.apiUrl) {
      throw new Error('The `apiUrl` option is required');
    }

    this.apiToken = apiToken;
    this.apiUrl = options.apiUrl;
    this.method = options.method;
    this.headers = options.headers || {};
    this.credentials = options.credentials;
    this.transport = options.transport || new HttpTransport({
      authorization: typeof apiToken === 'function' ? undefined : apiToken,
      apiUrl: this.apiUrl,
      method: this.method,
      headers: this.headers,
      credentials: this.credentials
    });
    this.pollInterval = options.pollInterval || 5;
    this.parseDateMeasures = options.parseDateMeasures;
    
    this.updateAuthorizationPromise = null;
  }

  request(method, params) {
    return this.transport.request(method, { baseRequestId: uuidv4(), ...params });
  }

  loadMethod(request, toResult, options, callback) {
    const mutexValue = ++mutexCounter;
    if (typeof options === 'function' && !callback) {
      callback = options;
      options = undefined;
    }
    
    options = options || {};

    const mutexKey = options.mutexKey || 'default';
    if (options.mutexObj) {
      options.mutexObj[mutexKey] = mutexValue;
    }

    const requestPromise = this.updateTransportAuthorization().then(() => request());

    let skipAuthorizationUpdate = true;
    let unsubscribed = false;

    const checkMutex = async () => {
      const requestInstance = await requestPromise;

      if (options.mutexObj && options.mutexObj[mutexKey] !== mutexValue) {
        unsubscribed = true;
        if (requestInstance.unsubscribe) {
          await requestInstance.unsubscribe();
        }
        throw MUTEX_ERROR;
      }
    };

    const loadImpl = async (response, next) => {
      const requestInstance = await requestPromise;

      const subscribeNext = async () => {
        if (options.subscribe && !unsubscribed) {
          if (requestInstance.unsubscribe) {
            return next();
          } else {
            await new Promise(resolve => setTimeout(() => resolve(), this.pollInterval * 1000));
            return next();
          }
        }
        return null;
      };

      const continueWait = async (wait) => {
        if (!unsubscribed) {
          if (wait) {
            await new Promise(resolve => setTimeout(() => resolve(), this.pollInterval * 1000));
          }
          return next();
        }
        return null;
      };
      
      if (options.subscribe && !skipAuthorizationUpdate) {
        await this.updateTransportAuthorization();
      }
      
      skipAuthorizationUpdate = false;

      if (response.status === 502) {
        await checkMutex();
        return continueWait(true);
      }

      let body = {};
      let text = '';
      try {
        text = await response.text();
        body = JSON.parse(text);
      } catch (_) {
        body.error = text;
      }

      if (body.error === 'Continue wait') {
        await checkMutex();
        if (options.progressCallback) {
          options.progressCallback(new ProgressResult(body));
        }
        return continueWait();
      }

      if (response.status !== 200) {
        await checkMutex();
        if (!options.subscribe && requestInstance.unsubscribe) {
          await requestInstance.unsubscribe();
        }

        const error = new RequestError(body.error, body); // TODO error class
        if (callback) {
          callback(error);
        } else {
          throw error;
        }

        return subscribeNext();
      }
      await checkMutex();
      if (!options.subscribe && requestInstance.unsubscribe) {
        await requestInstance.unsubscribe();
      }
      const result = toResult(body);
      if (callback) {
        callback(null, result);
      } else {
        return result;
      }

      return subscribeNext();
    };

    const promise = requestPromise.then(requestInstance => mutexPromise(requestInstance.subscribe(loadImpl)));

    if (callback) {
      return {
        unsubscribe: async () => {
          const requestInstance = await requestPromise;

          unsubscribed = true;
          if (requestInstance.unsubscribe) {
            return requestInstance.unsubscribe();
          }
          return null;
        }
      };
    } else {
      return promise;
    }
  }

  async updateTransportAuthorization() {
    if (this.updateAuthorizationPromise) {
      await this.updateAuthorizationPromise;
      return;
    }
    
    if (typeof this.apiToken === 'function') {
      this.updateAuthorizationPromise = new Promise(async (resolve, reject) => {
        try {
          const token = await this.apiToken();
          if (this.transport.authorization !== token) {
            this.transport.authorization = token;
          }
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.updateAuthorizationPromise = null;
        }
      });
      
      await this.updateAuthorizationPromise;
    }
  }

  load(query, options, callback) {
    return this.loadMethod(
      () => this.request('load', {
        query,
        queryType: 'multi'
      }),
      (response) => new ResultSet(response, { parseDateMeasures: this.parseDateMeasures }),
      options,
      callback
    );
  }

  sql(query, options, callback) {
    return this.loadMethod(
      () => this.request('sql', { query }),
      (response) => (Array.isArray(response) ? response.map((body) => new SqlQuery(body)) : new SqlQuery(response)),
      options,
      callback
    );
  }

  meta(options, callback) {
    return this.loadMethod(
      () => this.request('meta'),
      (body) => new Meta(body),
      options,
      callback
    );
  }

  dryRun(query, options, callback) {
    return this.loadMethod(
      () => this.request('dry-run', { query }),
      (response) => response,
      options,
      callback
    );
  }

  subscribe(query, options, callback) {
    return this.loadMethod(
      () => this.request('subscribe', {
        query,
        queryType: 'multi'
      }),
      (body) => new ResultSet(body, { parseDateMeasures: this.parseDateMeasures }),
      { ...options, subscribe: true },
      callback
    );
  }
}

export default (apiToken, options) => new CubejsApi(apiToken, options);

export { CubejsApi, HttpTransport, ResultSet };
export {
  areQueriesEqual,
  defaultHeuristics,
  movePivotItem,
  isQueryPresent,
  moveItemInArray,
  defaultOrder,
  flattenFilters,
  getQueryMembers,
  getOrderMembersFromOrder,
  GRANULARITIES
} from './utils';
