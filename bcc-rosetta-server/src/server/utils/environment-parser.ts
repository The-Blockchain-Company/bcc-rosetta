import envalid, { host, makeValidator, num, str } from 'envalid';
/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { TopologyConfig } from '../services/network-service';
import { configNotFoundError } from './errors';

export interface Environment {
  TOPOLOGY_FILE: TopologyConfig;
  PORT: number;
  BIND_ADDRESS: string;
  DB_CONNECTION_STRING: string;
  LOGGER_LEVEL: string;
  TOPOLOGY_FILE_PATH: string;
  DEFAULT_RELATIVE_TTL: number;
  BCC_CLI_PATH: string;
  PAGE_SIZE: number;
  BCC_NODE_PATH: string;
}

const existingFileValidator = makeValidator((filePath: string) => {
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  throw configNotFoundError();
});

export const parseEnvironment = (): Environment => {
  const environment = envalid.cleanEnv(process.env, {
    PORT: num(),
    BIND_ADDRESS: host(),
    DB_CONNECTION_STRING: str(),
    LOGGER_LEVEL: str(),
    TOPOLOGY_FILE_PATH: existingFileValidator(),
    DEFAULT_RELATIVE_TTL: num(),
    BCC_CLI_PATH: existingFileValidator(),
    PAGE_SIZE: num(),
    BCC_NODE_PATH: existingFileValidator(),
    GENESIS_SOPHIE_PATH: existingFileValidator(),
    BCC_NODE_SOCKET_PATH: str()
  });
  let topologyFile: TopologyConfig;
  try {
    topologyFile = JSON.parse(fs.readFileSync(path.resolve(environment.TOPOLOGY_FILE_PATH)).toString());
  } catch (error) {
    throw configNotFoundError();
  }
  return { ...environment, TOPOLOGY_FILE: topologyFile };
};
