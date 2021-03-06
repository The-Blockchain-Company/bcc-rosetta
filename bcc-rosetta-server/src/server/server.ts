import fastify from 'fastify';
import fastifyBlipp from 'fastify-blipp';
import openapiGlue from 'fastify-openapi-glue';
import StatusCodes from 'http-status-codes';
import ApiError from './api-error';
import { Services } from './services/services';
import * as Controllers from './controllers/controllers';
import { IncomingMessage, Server, ServerResponse } from 'http';
import { BccCli } from './utils/bcc/cli/bccnode-cli';
import { BccNode } from './utils/bcc/cli/bcc-node';
import { ErrorFactory } from './utils/errors';

interface ExtraParams {
  networkId: string;
  pageSize: number;
}

const getBodyLimit = (): number | undefined => {
  const bodyLimit = parseInt(process.env.BODY_LIMIT, 10);
  return !Number.isNaN(bodyLimit) ? bodyLimit : undefined;
};

/**
 * This function builds a Fastify instance connecting the services with the
 * corresponding fastify route handlers.
 *
 * @param services to be used to handle the requests
 * @param logger true if logger should be enabled, false otherwise
 */
const buildServer = (
  services: Services,
  bccCli: BccCli,
  bccNode: BccNode,
  logLevel: string,
  extraParameters: ExtraParams
): fastify.FastifyInstance<Server, IncomingMessage, ServerResponse> => {
  const server = fastify({ logger: { level: logLevel }, bodyLimit: getBodyLimit() });
  const { networkId, pageSize } = extraParameters;
  server.register(fastifyBlipp);
  server.register(openapiGlue, {
    specification: `${__dirname}/openApi.json`,
    service: Controllers.configure(services, bccCli, bccNode, networkId, pageSize),
    noAdditional: true
  });

  // Custom error handling is needed as the specified by Rosetta API doesn't match
  // the fastify default one
  server.setErrorHandler((error: Error, request, reply) => {
    let toSend = error;
    request.log.error(error, '[errorHandler] An error ocurred and will be sent as response');
    if (error instanceof ApiError === false) {
      toSend = ErrorFactory.unspecifiedError(`An error occurred for request ${request.id}: ${error.message}`);
    }
    // rosseta-go-sdk always returns 500
    reply.status(StatusCodes.INTERNAL_SERVER_ERROR).send({ ...toSend, message: toSend.message });
  });

  return server;
};

export default buildServer;
