import { ethers } from 'ethers';
import { ChainArtifacts, ContractData } from '../types';
import { renderTrace } from '../trace';

/* eslint-disable no-case-declarations */

import Debug from 'debug';
import { Logger } from 'ethers/lib/utils';

const debug = Debug('cannon:builder:error');

export async function handleTxnError(
  artifacts: ChainArtifacts,
  provider: ethers.providers.Provider,
  err: any
): Promise<any> {
  if (err instanceof CannonTraceError || (err.toString() as string).includes('CannonTraceError')) {
    // error already parsed
    debug('skipping trace of error because already processed', err.toString());
    throw err;
  }

  debug('handle txn error received', err.toString());

  let errorCodeHex: string | null = null;
  let txnData: ethers.providers.TransactionRequest | null = null;
  let txnHash: string | null = null;

  let traces: TraceEntry[] = [];

  if (err.code === 'UNPREDICTABLE_GAS_LIMIT') {
    return handleTxnError(artifacts, provider, err.error);
  } else if (err.code === 'CALL_EXCEPTION' || err.code === 3) {
    txnData = err.transaction;
    errorCodeHex = err.data;
  } else if (err.code === -32015) {
    errorCodeHex = err.message.split(' ')[1];
  } else if (err.code === -32603 && err.data.originalError) {
    errorCodeHex = err.data.originalError.data;
  } else if (err.code === -32603 && err.data.data) {
    errorCodeHex = err.data.data;
  }
  if (err.reason === 'processing response error') {
    txnData = JSON.parse(err.requestBody).params[0];
    errorCodeHex = err.error.data;
  }

  if (txnData && (await isAnvil(provider))) {
    const fullTxn = {
      gasLimit: 20000000, // should ensure we get an actual failed receipt
      ...txnData,
    };

    // then, run it for real so we can get a trace
    try {
      await (provider as ethers.providers.JsonRpcProvider).send('hardhat_impersonateAccount', [fullTxn.from]);
      const pushedTxn = await (provider as ethers.providers.JsonRpcProvider)
        .getSigner(fullTxn.from)
        .sendTransaction(fullTxn);

      try {
        await pushedTxn.wait();
      } catch {
        // intentionally empty
      }
      txnHash = pushedTxn.hash;
    } catch (err) {
      console.error('warning: failed to force through transaction:', err);
    }
  }

  if (txnHash && (provider as ethers.providers.JsonRpcProvider).send) {
    // try getting trace data
    try {
      traces = await (provider as ethers.providers.JsonRpcProvider).send('trace_transaction', [txnHash]);
    } catch (err) {
      console.error('warning: trace api unavailable', err);
      // TODO: trace API most likely not available
    }
  }

  if (traces.length || txnHash || txnData || errorCodeHex) {
    throw new CannonTraceError(err, artifacts, errorCodeHex, traces);
  } else {
    throw err;
  }
}

class CannonTraceError extends Error {
  error: Error;

  // this is needed here to prevent ethers from intercepting the error
  // `NONCE_EXPIRED` is a very innocent looking error, so ethers will simply forward it.
  code: string = Logger.errors.NONCE_EXPIRED;

  constructor(error: Error, ctx: ChainArtifacts, errorCodeHex: string | null, traces: TraceEntry[]) {
    let contractName = 'unknown';
    let decodedMsg = error.message;
    if (errorCodeHex) {
      try {
        const r = findContract(ctx, ({ address, abi }) => {
          try {
            new ethers.Contract(address, abi).interface.parseError(errorCodeHex);
            return true;
          } catch (_) {
            // intentionally empty
          }

          return false;
        });
        if (r !== null) {
          contractName = r?.name;
        }

        decodedMsg = parseContractErrorReason(r?.contract ?? null, errorCodeHex);
      } catch {
        // intentionally empty
      }
    }

    // now we can make ourselves a thing
    super(`transaction reverted in contract ${contractName}: ${decodedMsg}\n\n${renderTrace(ctx, traces)}\n\n`);

    this.error = error;
  }
}

export type CallTraceAction = {
  callType: 'staticcall' | 'delegatecall' | 'call';
  from: string;
  gas: string;
  input: string;
  to: string;
  value: string;
};

export type CreateTraceAction = {
  from: string;
  gas: string;
  init: string;
  value: string;
};

export type TraceEntry = {
  action: CreateTraceAction | CallTraceAction;
  blockHash: string;
  blockNumber: string;
  result: {
    gasUsed: string;
    code?: string;
    output: string;
  };
  subtraces: number;
  traceAddress: number[];
  transactionHash: string;
  transactionPosition: number;
  type: 'call' | 'create';
};

async function isAnvil(provider: ethers.providers.Provider) {
  return (
    (provider as ethers.providers.JsonRpcProvider).send &&
    (await (provider as ethers.providers.JsonRpcProvider).send('web3_clientVersion', [])).includes('anvil')
  );
}

export function findContract(
  ctx: ChainArtifacts,
  condition: (v: { address: string; abi: any[] }) => boolean,
  prefix = ''
): { name: string; contract: ethers.Contract } | null {
  for (const name in ctx.contracts) {
    if (condition(ctx.contracts[name])) {
      return {
        name: prefix + name,
        contract: new ethers.Contract(ctx.contracts[name].address, ctx.contracts[name].abi),
      };
    }
  }

  for (const name in ctx.imports) {
    const result = findContract(ctx.imports[name], condition, `${prefix}${name}.`);
    if (result) {
      return result;
    }
  }

  return null;
}

export function renderResult(result: ethers.utils.Result) {
  return '(' + result.map((v) => (v.toString ? '"' + v.toString() + '"' : v)).join(', ') + ')';
}

/**
 * Decode transaction error data to a human-readable error message
 * This method decodes general tx errors (i.e. Panic and Error), and
 * decodes against generated ABIs
 * @param data transaction data
 * @param abis ABIs of all involved contracts if available
 * @return Human-readable error message if decode to error is successful, otherwise null
 */
export function decodeTxError(data: string, abis: ContractData['abi'][] = []) {
  if (data.startsWith(ethers.utils.id('Panic(uint256)').slice(0, 10))) {
    // this is the `Panic` builtin opcode
    const reason = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + data.slice(10))[0];
    switch (reason.toNumber()) {
      case 0x00:
        return 'Panic("generic/unknown error")';
      case 0x01:
        return 'Panic("assertion failed")';
      case 0x11:
        return 'Panic("unchecked underflow/overflow")';
      case 0x12:
        return 'Panic("division by zero")';
      case 0x21:
        return 'Panic("invalid number to enum conversion")';
      case 0x22:
        return 'Panic("access to incorrect storage byte array")';
      case 0x31:
        return 'Panic("pop() empty array")';
      case 0x32:
        return 'Panic("out of bounds array access")';
      case 0x41:
        return 'Panic("out of memory")';
      case 0x51:
        return 'Panic("invalid internal function")';
      default:
        return 'Panic("unknown")';
    }
  } else if (data.startsWith(ethers.utils.id('Error(string)').slice(0, 10))) {
    // this is the `Error` builtin opcode
    const reason = ethers.utils.defaultAbiCoder.decode(['string'], '0x' + data.slice(10));
    return `Error("${reason}")`;
  }
  for (const abi of abis) {
    const iface = new ethers.utils.Interface(abi as string[]);
    try {
      const error = iface.parseError(data);
      return error.name + renderResult(error.args);
    } catch (err) {
      // intentionally empty
    }
  }
  return null;
}

export function parseContractErrorReason(contract: ethers.Contract | null, data: string): string {
  const result = decodeTxError(data);

  if (result) {
    return result;
  }
  if (contract) {
    try {
      const error = contract.interface.parseError(data);
      return error.name + renderResult(error.args);
    } catch (err) {
      // intentionally empty
    }
  }

  return data;
}
