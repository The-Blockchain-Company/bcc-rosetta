/* eslint-disable wrap-regex */
import BccWasm, {
  AssetName,
  Assets,
  BigNum,
  MultiAsset,
  PoolRetirement,
  ScriptHash,
  StakeDelegation,
  StakeDeregistration,
  StakeRegistration,
  Value
} from 'bcc-serialization-lib';
import { Logger } from 'fastify';
import { NetworkIdentifier, OperationType, RelayType } from '../constants';
import { ErrorFactory } from '../errors';
import { hexStringToBuffer } from '../formatters';
import { isPolicyIdValid, isTokenNameValid } from '../validations';
import { generateRewardAddress, generateAddress, parseToRewardAddress } from './addresses';
import { getStakingCredentialFromHex } from './staking-credentials';
import { parsePoolOwners, parsePoolRewardAccount } from './transactions-processor';

const isPositiveNumber = (value: string): boolean => /^\+?\d+/.test(value);

const validateAndParseTokenBundle = (
  logger: Logger,
  tokenBundle: Components.Schemas.TokenBundleItem[]
): BccWasm.MultiAsset =>
  tokenBundle.reduce((multiAssets, { policyId, tokens }) => {
    if (!isPolicyIdValid(policyId)) {
      logger.error(`[validateAndParseTokenBundle] PolicyId ${policyId} is not valid`);
      throw ErrorFactory.transactionOutputsParametersMissingError(`PolicyId ${policyId} is not valid`);
    }
    const policy = ScriptHash.from_bytes(hexStringToBuffer(policyId));
    const assetsToAdd = tokens.reduce((assets, { currency: { symbol: tokenName }, value: assetValue }) => {
      if (!isTokenNameValid(tokenName)) {
        logger.error(`[validateAndParseTokenBundle] Token name ${tokenName} is not valid`);
        throw ErrorFactory.transactionOutputsParametersMissingError(`Token name ${tokenName} is not valid`);
      }
      const assetName = AssetName.new(hexStringToBuffer(tokenName));
      if (assets.get(assetName) !== undefined) {
        logger.error(
          `[validateAndParseTokenBundle] Token name ${tokenName} has already been added for policy ${policyId}`
        );
        throw ErrorFactory.transactionOutputsParametersMissingError(
          `Token name ${tokenName} has already been added for policy ${policyId} and will be overriden`
        );
      }
      if (assetValue === undefined || !assetValue[0]) {
        logger.error(
          `[validateAndParseTokenBundle] Token with name ${tokenName} for policy ${policyId} has no value or is empty`
        );
        throw ErrorFactory.transactionOutputsParametersMissingError(
          `Token with name ${tokenName} for policy ${policyId} has no value or is empty`
        );
      }
      if (!isPositiveNumber(assetValue)) {
        logger.error(`[validateAndParseTokenBundle] Asset ${tokenName} has negative or invalid value '${assetValue}'`);
        throw ErrorFactory.transactionOutputsParametersMissingError(
          `Asset ${tokenName} has negative or invalid value '${assetValue}'`
        );
      }
      assets.insert(assetName, BigNum.from_str(assetValue));
      return assets;
    }, Assets.new());
    multiAssets.insert(policy, assetsToAdd);
    return multiAssets;
  }, MultiAsset.new());

const validateAndParseTransactionOutput = (
  logger: Logger,
  output: Components.Schemas.Operation
): BccWasm.TransactionOutput => {
  let address;
  try {
    address = output.account && generateAddress(output.account.address);
  } catch (error) {
    throw ErrorFactory.transactionOutputDeserializationError(
      `Invalid input: ${output.account?.address} - ${error.toString()}`
    );
  }
  if (!address) {
    logger.error('[validateAndParseTransactionOutput] Output has missing address field');
    throw ErrorFactory.transactionOutputsParametersMissingError('Output has missing address field');
  }
  const outputValue = output.amount?.value;
  if (!output.amount || !outputValue) {
    logger.error('[validateAndParseTransactionOutput] Output has missing amount value field');
    throw ErrorFactory.transactionOutputsParametersMissingError('Output has missing amount value field');
  }
  if (!isPositiveNumber(outputValue)) {
    logger.error(`[validateAndParseTransactionOutput] Output has negative or invalid value '${outputValue}'`);
    throw ErrorFactory.transactionOutputsParametersMissingError('Output has negative amount value');
  }
  const value = Value.new(BigNum.from_str(outputValue));
  if (output.metadata?.tokenBundle)
    value.set_multiasset(validateAndParseTokenBundle(logger, output.metadata.tokenBundle));
  try {
    return BccWasm.TransactionOutput.new(address, value);
  } catch (error) {
    throw ErrorFactory.transactionOutputDeserializationError(
      `Invalid input: ${output.account?.address} - ${error.toString()}`
    );
  }
};

const validateAndParseTransactionInput = (
  logger: Logger,
  input: Components.Schemas.Operation
): BccWasm.TransactionInput => {
  if (!input.coin_change) {
    logger.error('[validateAndParseTransactionInput] Input has missing coin_change');
    throw ErrorFactory.transactionInputsParametersMissingError('Input has missing coin_change field');
  }
  const [transactionId, index] = input.coin_change && input.coin_change.coin_identifier.identifier.split(':');
  if (!(transactionId && index)) {
    logger.error('[validateAndParseTransactionInput] Input has missing transactionId and index');
    throw ErrorFactory.transactionInputsParametersMissingError('Input has invalid coin_identifier field');
  }
  const value = input.amount?.value;
  if (!value) {
    logger.error('[validateAndParseTransactionInput] Input has missing amount value field');
    throw ErrorFactory.transactionInputsParametersMissingError('Input has missing amount value field');
  }
  if (isPositiveNumber(value)) {
    logger.error('[validateAndParseTransactionInput] Input has positive value');
    throw ErrorFactory.transactionInputsParametersMissingError('Input has positive amount value');
  }
  try {
    return BccWasm.TransactionInput.new(
      BccWasm.TransactionHash.from_bytes(Buffer.from(transactionId, 'hex')),
      Number(index)
    );
  } catch (error) {
    throw ErrorFactory.transactionInputDeserializationError(
      'There was an error deserializating transaction input: '.concat(error)
    );
  }
};

const processStakeKeyRegistration = (
  logger: Logger,
  operation: Components.Schemas.Operation
): BccWasm.Certificate => {
  logger.info('[processStakeKeyRegistration] About to process stake key registration');
  // eslint-disable-next-line camelcase
  const credential = getStakingCredentialFromHex(logger, operation.metadata?.staking_credential);
  return BccWasm.Certificate.new_stake_registration(StakeRegistration.new(credential));
};

const validateAndParsePoolKeyHash = (logger: Logger, poolKeyHash?: string): BccWasm.Ed25519KeyHash => {
  if (!poolKeyHash) {
    logger.error('[validateAndParsePoolKeyHash] no pool key hash provided');
    throw ErrorFactory.missingPoolKeyError();
  }
  let parsedPoolKeyHash: BccWasm.Ed25519KeyHash;
  try {
    parsedPoolKeyHash = BccWasm.Ed25519KeyHash.from_bytes(Buffer.from(poolKeyHash, 'hex'));
  } catch (error) {
    logger.error('[validateAndParsePoolKeyHash] invalid pool key hash');
    throw ErrorFactory.invalidPoolKeyError(error);
  }
  return parsedPoolKeyHash;
};

const validateAndParseRewardAddress = (logger: Logger, rwrdAddress: string): BccWasm.RewardAddress => {
  let rewardAddress: BccWasm.RewardAddress | undefined;
  try {
    rewardAddress = parseToRewardAddress(rwrdAddress);
  } catch (error) {
    logger.error(`[validateAndParseRewardAddress] invalid reward address ${rwrdAddress}`);
    throw ErrorFactory.invalidAddressError();
  }
  if (!rewardAddress) throw ErrorFactory.invalidAddressError();
  return rewardAddress;
};

const validateAndParsePoolOwners = (logger: Logger, owners: Array<string>): BccWasm.Ed25519KeyHashes => {
  const parsedOwners = BccWasm.Ed25519KeyHashes.new();
  try {
    owners.forEach(owner => {
      const rewardAddress = parseToRewardAddress(owner);
      if (rewardAddress) {
        const ownerKey = rewardAddress.payment_cred().to_keyhash();
        ownerKey && parsedOwners.add(ownerKey);
      }
    });
  } catch (error) {
    logger.error('[validateAndParsePoolOwners] there was an error parsing pool owners');
    throw ErrorFactory.invalidPoolOwnersError(error);
  }
  if (parsedOwners.len() !== owners.length)
    throw ErrorFactory.invalidPoolOwnersError('Invalid pool owners addresses provided');
  return parsedOwners;
};

export const validateAndParsePoolRegistrationCert = (
  logger: Logger,
  network: NetworkIdentifier,
  poolRegistrationCert?: string,
  poolKeyHash?: string
): { certificate: BccWasm.Certificate; addresses: string[] } => {
  if (!poolKeyHash) {
    logger.error('[validateAndParsePoolRegistrationCert] no cold key provided for pool registration');
    throw ErrorFactory.missingPoolKeyError();
  }
  if (!poolRegistrationCert) {
    logger.error(
      '[validateAndParsePoolRegistrationCert] no pool registration certificate provided for pool registration'
    );
    throw ErrorFactory.missingPoolCertError();
  }
  let parsedCertificate: BccWasm.Certificate;
  try {
    parsedCertificate = BccWasm.Certificate.from_bytes(Buffer.from(poolRegistrationCert, 'hex'));
  } catch (error) {
    logger.error('[validateAndParsePoolRegistrationCert] invalid pool registration certificate');
    throw ErrorFactory.invalidPoolRegistrationCert(error);
  }
  const poolRegistration = parsedCertificate.as_pool_registration();
  if (!poolRegistration) {
    logger.error('[validateAndParsePoolRegistrationCert] invalid certificate type');
    throw ErrorFactory.invalidPoolRegistrationCertType();
  }
  const poolParameters = poolRegistration.pool_params();
  const ownersAddresses = parsePoolOwners(logger, network, poolParameters);
  const rewardAddress = parsePoolRewardAccount(logger, network, poolParameters);
  return { certificate: parsedCertificate, addresses: [...ownersAddresses, poolKeyHash, rewardAddress] };
};

const processOperationCertification = (
  logger: Logger,
  network: NetworkIdentifier,
  operation: Components.Schemas.Operation
): { certificate: BccWasm.Certificate; address: string } => {
  logger.info(`[processOperationCertification] About to process operation of type ${operation.type}`);
  // eslint-disable-next-line camelcase
  const credential = getStakingCredentialFromHex(logger, operation.metadata?.staking_credential);
  const address = generateRewardAddress(logger, network, credential);
  if (operation.type === OperationType.STAKE_DELEGATION) {
    // eslint-disable-next-line camelcase
    const poolKeyHash = validateAndParsePoolKeyHash(logger, operation.metadata?.pool_key_hash);
    const certificate = BccWasm.Certificate.new_stake_delegation(StakeDelegation.new(credential, poolKeyHash));
    return { certificate, address };
  }
  return {
    certificate: BccWasm.Certificate.new_stake_deregistration(StakeDeregistration.new(credential)),
    address
  };
};

const validatePort = (logger: Logger, port: string): void => {
  const parsedPort = Number.parseInt(port, 10);
  if (!isPositiveNumber(port) || Number.isNaN(parsedPort)) {
    logger.error(`[validateAndParsePort] Invalid port ${port} received`);
    throw ErrorFactory.invalidPoolRelaysError(`Invalid port ${port} received`);
  }
};

const parseIpv4 = (ip?: string): BccWasm.Ipv4 | undefined => {
  if (ip) {
    const parsedIp = Buffer.from(ip.split('.'));
    return BccWasm.Ipv4.new(parsedIp);
  }
  return ip as undefined;
};

const parseIpv6 = (ip?: string): BccWasm.Ipv6 | undefined => {
  if (ip) {
    const parsedIp = Buffer.from(ip.replace(/:/g, ''), 'hex');
    return BccWasm.Ipv6.new(parsedIp);
  }
  return ip as undefined;
};

const generateSpecificRelay = (logger: Logger, relay: Components.Schemas.Relay): BccWasm.Relay => {
  try {
    switch (relay.type) {
      case RelayType.SINGLE_HOST_ADDR: {
        return BccWasm.Relay.new_single_host_addr(
          BccWasm.SingleHostAddr.new(
            relay.port ? Number.parseInt(relay.port, 10) : undefined,
            parseIpv4(relay.ipv4),
            parseIpv6(relay.ipv6)
          )
        );
      }
      case RelayType.SINGLE_HOST_NAME: {
        if (!relay.dnsName) {
          throw ErrorFactory.missingDnsNameError();
        }
        return BccWasm.Relay.new_single_host_name(
          BccWasm.SingleHostName.new(
            relay.port ? Number.parseInt(relay.port, 10) : undefined,
            BccWasm.DNSRecordAorAAAA.new(relay.dnsName)
          )
        );
      }
      case RelayType.MULTI_HOST_NAME: {
        if (!relay.dnsName) {
          throw ErrorFactory.missingDnsNameError();
        }
        return BccWasm.Relay.new_multi_host_name(
          BccWasm.MultiHostName.new(BccWasm.DNSRecordSRV.new(relay.dnsName))
        );
      }
      default: {
        throw ErrorFactory.invalidPoolRelayTypeError();
      }
    }
  } catch (error) {
    logger.error('[validateAndParsePoolRelays] invalid pool relay');
    throw ErrorFactory.invalidPoolRelaysError(error);
  }
};

const validateAndParsePoolRelays = (logger: Logger, relays: Components.Schemas.Relay[]): BccWasm.Relays => {
  if (relays.length === 0) throw ErrorFactory.invalidPoolRelaysError('Empty relays received');
  const generatedRelays = BccWasm.Relays.new();
  for (const relay of relays) {
    relay.port && validatePort(logger, relay.port);
    const generatedRelay = generateSpecificRelay(logger, relay);
    generatedRelays.add(generatedRelay);
  }

  return generatedRelays;
};

const validateAndParsePoolRegistationParameters = (
  logger: Logger,
  poolRegistrationParameters: Components.Schemas.PoolRegistrationParams
) => {
  const denominator = poolRegistrationParameters?.margin?.denominator;
  const numerator = poolRegistrationParameters?.margin?.numerator;

  if (!denominator || !numerator) {
    logger.error(
      '[validateAndParsePoolRegistationParameters] Missing margin parameter at pool registration parameters'
    );
    throw ErrorFactory.invalidPoolRegistrationParameters('Missing margin parameter at pool registration parameters');
  }
  const poolParameters: { [key: string]: string } = {
    cost: poolRegistrationParameters.cost,
    pledge: poolRegistrationParameters.pledge,
    numerator,
    denominator
  };
  // eslint-disable-next-line unicorn/prevent-abbreviations
  const parsedPoolParams: { [key: string]: BigNum } = {};
  try {
    Object.keys(poolParameters).forEach(k => {
      const value = poolParameters[k];
      if (!isPositiveNumber(value)) {
        logger.error(`[validateAndParsePoolRegistationParameters] Given ${k} ${value} is invalid`);
        throw ErrorFactory.invalidPoolRegistrationParameters(`Given ${k} ${value} is invalid`);
      }
      parsedPoolParams[k] = BccWasm.BigNum.from_str(poolParameters[k]);
    });
    return parsedPoolParams;
  } catch (error) {
    logger.error('[validateAndParsePoolRegistationParameters] Given pool parameters are invalid');
    throw ErrorFactory.invalidPoolRegistrationParameters(error?.details?.message ? error.details.message : error);
  }
};

const validateAndParsePoolMetadata = (
  logger: Logger,
  metadata?: Components.Schemas.PoolMetadata
): BccWasm.PoolMetadata | undefined => {
  let parsedMetadata: BccWasm.PoolMetadata | undefined;
  try {
    if (metadata)
      parsedMetadata = BccWasm.PoolMetadata.new(
        BccWasm.URL.new(metadata.url),
        BccWasm.PoolMetadataHash.from_bytes(Buffer.from(metadata.hash, 'hex'))
      );
  } catch (error) {
    logger.error('[validateAndParsePoolMetadata] invalid pool metadata');
    throw ErrorFactory.invalidPoolMetadataError(error);
  }
  return parsedMetadata;
};

const processPoolRegistration = (
  logger: Logger,
  network: NetworkIdentifier,
  operation: Components.Schemas.Operation
): { certificate: BccWasm.Certificate; addresses: string[] } => {
  logger.info('[processPoolRegistration] About to process pool registration operation');

  if (!operation?.metadata?.poolRegistrationParams) {
    logger.error('[processPoolRegistration] Pool_registration was not provided');
    throw ErrorFactory.missingPoolRegistrationParameters();
  }
  const { rewardAddress, poolOwners, relays } = operation.metadata?.poolRegistrationParams;

  const { pledge, cost, numerator, denominator } = validateAndParsePoolRegistationParameters(
    logger,
    operation?.metadata?.poolRegistrationParams
  );
  // eslint-disable-next-line camelcase
  const poolKeyHash = validateAndParsePoolKeyHash(logger, operation.account?.address);

  logger.info('[processPoolRegistration] About to validate and parse reward address');
  const parsedAddress = validateAndParseRewardAddress(logger, rewardAddress);

  logger.info('[processPoolRegistration] About to generate pool owners');
  const owners = validateAndParsePoolOwners(logger, poolOwners);

  logger.info('[processPoolRegistration] About to generate pool relays');
  const parsedRelays = validateAndParsePoolRelays(logger, relays);

  logger.info('[processPoolRegistration] About to generate pool metadata');
  const poolMetadata = validateAndParsePoolMetadata(logger, operation.metadata?.poolRegistrationParams.poolMetadata);

  logger.info('[processPoolRegistration] About to generate Pool Registration');
  const wasmPoolRegistration = BccWasm.PoolRegistration.new(
    BccWasm.PoolParams.new(
      poolKeyHash,
      BccWasm.VRFKeyHash.from_bytes(Buffer.from(operation.metadata?.poolRegistrationParams.vrfKeyHash, 'hex')),
      pledge,
      cost,
      BccWasm.UnitInterval.new(numerator, denominator),
      parsedAddress,
      owners,
      parsedRelays,
      poolMetadata
    )
  );
  logger.info('[processPoolRegistration] Generating Pool Registration certificate');
  const certificate = BccWasm.Certificate.new_pool_registration(wasmPoolRegistration);
  logger.info('[processPoolRegistration] Successfully created Pool Registration certificate');

  const totalAddresses = [...poolOwners, rewardAddress, operation.account!.address];
  return { certificate, addresses: totalAddresses };
};

const processPoolRegistrationWithCert = (
  logger: Logger,
  network: NetworkIdentifier,
  operation: Components.Schemas.Operation
): { certificate: BccWasm.Certificate; addresses: string[] } => {
  const { certificate, addresses } = validateAndParsePoolRegistrationCert(
    logger,
    network,
    operation?.metadata?.poolRegistrationCert,
    operation?.account?.address
  );
  return { certificate, addresses };
};

const processPoolRetirement = (
  logger: Logger,
  operation: Components.Schemas.Operation
): { certificate: BccWasm.Certificate; poolKeyHash: string } => {
  logger.info(`[processPoolRetiring] About to process operation of type ${operation.type}`);
  if (operation.metadata?.epoch && operation.account?.address) {
    const epoch = operation.metadata.epoch;
    const keyHash = validateAndParsePoolKeyHash(logger, operation.account?.address);
    return {
      certificate: BccWasm.Certificate.new_pool_retirement(PoolRetirement.new(keyHash, epoch)),
      poolKeyHash: operation.account?.address
    };
  }
  logger.error('[processPoolRetiring] Epoch operation metadata is missing');
  throw ErrorFactory.missingMetadataParametersForPoolRetirement();
};

const processWithdrawal = (
  logger: Logger,
  network: NetworkIdentifier,
  operation: Components.Schemas.Operation
): { reward: BccWasm.RewardAddress; address: string } => {
  logger.info('[processWithdrawal] About to process withdrawal');
  // eslint-disable-next-line camelcase
  const credential = getStakingCredentialFromHex(logger, operation.metadata?.staking_credential);
  const address = generateRewardAddress(logger, network, credential);
  return { reward: BccWasm.RewardAddress.new(network, credential), address };
};

const operationProcessor: (
  logger: Logger,
  operation: Components.Schemas.Operation,
  network: NetworkIdentifier,
  resultAccumulator: ProcessOperationsResult
) => {
  [type: string]: () => ProcessOperationsResult;
} = (logger, operation, network, resultAccumulator) => ({
  [OperationType.INPUT]: () => {
    resultAccumulator.transactionInputs.add(validateAndParseTransactionInput(logger, operation));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resultAccumulator.addresses.push(operation.account!.address);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resultAccumulator.inputAmounts.push(operation.amount!.value);
    return resultAccumulator;
  },
  [OperationType.OUTPUT]: () => {
    resultAccumulator.transactionOutputs.add(validateAndParseTransactionOutput(logger, operation));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    resultAccumulator.outputAmounts.push(operation.amount!.value);
    return resultAccumulator;
  },
  [OperationType.STAKE_KEY_REGISTRATION]: () => {
    resultAccumulator.certificates.add(processStakeKeyRegistration(logger, operation));
    resultAccumulator.stakeKeyRegistrationsCount++;
    return resultAccumulator;
  },
  [OperationType.STAKE_KEY_DEREGISTRATION]: () => {
    const { certificate, address } = processOperationCertification(logger, network, operation);
    resultAccumulator.certificates.add(certificate);
    resultAccumulator.addresses.push(address);
    resultAccumulator.stakeKeyDeRegistrationsCount++;
    return resultAccumulator;
  },
  [OperationType.STAKE_DELEGATION]: () => {
    const { certificate, address } = processOperationCertification(logger, network, operation);
    resultAccumulator.certificates.add(certificate);
    resultAccumulator.addresses.push(address);
    return resultAccumulator;
  },
  [OperationType.WITHDRAWAL]: () => {
    const { reward, address } = processWithdrawal(logger, network, operation);
    const withdrawalAmount = BigInt(operation.amount?.value);
    resultAccumulator.withdrawalAmounts.push(withdrawalAmount);
    resultAccumulator.withdrawals.insert(reward, BigNum.from_str(withdrawalAmount.toString()));
    resultAccumulator.addresses.push(address);
    return resultAccumulator;
  },
  [OperationType.POOL_REGISTRATION]: () => {
    const { certificate, addresses } = processPoolRegistration(logger, network, operation);
    resultAccumulator.certificates.add(certificate);
    resultAccumulator.addresses.push(...addresses);
    resultAccumulator.poolRegistrationsCount++;
    return resultAccumulator;
  },
  [OperationType.POOL_REGISTRATION_WITH_CERT]: () => {
    const { certificate, addresses } = processPoolRegistrationWithCert(logger, network, operation);
    resultAccumulator.certificates.add(certificate);
    resultAccumulator.addresses.push(...addresses);
    resultAccumulator.poolRegistrationsCount++;
    return resultAccumulator;
  },
  [OperationType.POOL_RETIREMENT]: () => {
    const { certificate, poolKeyHash } = processPoolRetirement(logger, operation);
    resultAccumulator.certificates.add(certificate);
    resultAccumulator.addresses.push(poolKeyHash);
    return resultAccumulator;
  }
});

export interface ProcessOperationsResult {
  transactionInputs: BccWasm.TransactionInputs;
  transactionOutputs: BccWasm.TransactionOutputs;
  certificates: BccWasm.Certificates;
  withdrawals: BccWasm.Withdrawals;
  addresses: string[];
  inputAmounts: string[];
  outputAmounts: string[];
  withdrawalAmounts: bigint[];
  stakeKeyRegistrationsCount: number;
  stakeKeyDeRegistrationsCount: number;
  poolRegistrationsCount: number;
}

/**
 * Processes the given operations and generates according Bcc related objects to be used
 * to build a transaction.
 *
 * Extra information is added as it might be required and we are traversing the operations
 * already.
 *
 * @param logger
 * @param network
 * @param operations
 */
export const convert = (
  logger: Logger,
  network: NetworkIdentifier,
  operations: Components.Schemas.Operation[]
): ProcessOperationsResult => {
  const result: ProcessOperationsResult = {
    transactionInputs: BccWasm.TransactionInputs.new(),
    transactionOutputs: BccWasm.TransactionOutputs.new(),
    certificates: BccWasm.Certificates.new(),
    withdrawals: BccWasm.Withdrawals.new(),
    addresses: [],
    inputAmounts: [],
    outputAmounts: [],
    withdrawalAmounts: [],
    stakeKeyRegistrationsCount: 0,
    stakeKeyDeRegistrationsCount: 0,
    poolRegistrationsCount: 0
  };

  return operations.reduce<ProcessOperationsResult>((previousResult, operation) => {
    const type = operation.type;
    const processor = operationProcessor(logger, operation, network, previousResult);
    if (!processor[type]) {
      logger.error(`[processOperations] Operation with id ${operation.operation_identifier} has invalid type`);
      throw ErrorFactory.invalidOperationTypeError();
    }
    return processor[type]();
  }, result);
};
