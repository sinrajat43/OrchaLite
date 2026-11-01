import { engineOptionsFromEnv } from './engine-options';

describe('engineOptionsFromEnv', () => {
  it('runs every role with no task limits by default', () => {
    expect(engineOptionsFromEnv({})).toMatchObject({ roles: ['api', 'scheduler', 'worker'], taskLimits: {} });
  });

  it('reads task limits, ignoring spaces and empty entries', () => {
    expect(engineOptionsFromEnv({ ORCHALITE_TASK_LIMITS: 'http.request=10, mongo.insert=5,' }).taskLimits).toEqual({ 'http.request': 10, 'mongo.insert': 5 });
  });

  it.each(['http.request', 'http.request=0', 'http.request=many', '=5'])('rejects the task limit "%s"', entry => {
    expect(() => engineOptionsFromEnv({ ORCHALITE_TASK_LIMITS: entry })).toThrow(`expected task=limit, got "${entry}"`);
  });

  it('rejects an unknown role', () => {
    expect(() => engineOptionsFromEnv({ ORCHALITE_ROLES: 'api,cook' })).toThrow('unknown role cook');
  });
});
