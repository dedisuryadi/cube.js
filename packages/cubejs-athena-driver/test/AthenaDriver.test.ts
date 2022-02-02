import { DriverTests } from '@cubejs-backend/testing';

import { AthenaDriver } from '../src';

DriverTests.config();

describe('AthenaDriver', () => {
  let tests: DriverTests;

  jest.setTimeout(2 * 60 * 1000);

  beforeAll(async () => {
    tests = new DriverTests(new AthenaDriver({}));
  });

  afterAll(async () => {
    await tests.release();
  });

  test('query', async () => {
    await tests.testQuery();
  });

  test('stream', async () => {
    await tests.testStream();
  });
});