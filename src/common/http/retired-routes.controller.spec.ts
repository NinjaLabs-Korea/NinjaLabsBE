import { GoneException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RetiredRoutesController } from './retired-routes.controller';

describe('RetiredRoutesController', () => {
  it('answers 410 AGENT_API_RETIRED', () => {
    const controller = new RetiredRoutesController();
    let error: unknown;
    try { controller.agentApiRetired(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(GoneException);
    expect(error).toMatchObject({ status: 410, response: { statusCode: 410, error: 'Gone', message: 'AGENT_API_RETIRED' } });
  });

  it('is registered for every method on /agent-api/v1 and below', () => {
    const handler = RetiredRoutesController.prototype.agentApiRetired;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.ALL);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toEqual(['agent-api/v1', 'agent-api/v1/*path']);
  });
});
