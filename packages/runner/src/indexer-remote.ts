import {
  Cell,
  CellCollector,
  CellCollectorResults,
  Hexadecimal,
  HexString,
  Indexer,
  QueryOptions,
  Script,
  Tip,
  OutPoint,
  HexNumber,
} from '@ckb-lumos/base';
import { RPC } from '@ckb-lumos/rpc';
import axios from 'axios';
import { logger } from './logger';

function asyncSleep(timeout: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

export enum ScriptType {
  type = 'type',
  lock = 'lock',
}

export enum Order {
  asc = 'asc',
  desc = 'desc',
}

export type HexadecimalRange = [Hexadecimal, Hexadecimal];

export interface SearchKey {
  script: Script;
  script_type: ScriptType;
  filter?: {
    script?: Script;
    output_data_len_range?: HexadecimalRange;
    output_capacity_range?: HexadecimalRange;
    block_range?: HexadecimalRange;
  };
}

export interface GetLiveCellsResult {
  last_cursor: string;
  objects: IndexerCell[];
}

export interface IndexerCell {
  block_number: Hexadecimal;
  out_point: OutPoint;
  output: {
    capacity: HexNumber;
    lock: Script;
    type?: Script;
  };
  output_data: HexString;
  tx_index: Hexadecimal;
}

export interface TerminatorResult {
  stop: boolean;
  push: boolean;
}

export declare type Terminator = (index: number, cell: Cell) => TerminatorResult;

const DefaultTerminator: Terminator = (_index, _cell) => {
  return { stop: false, push: true };
};

export class CkbIndexer implements Indexer {
  public uri: string;

  constructor(public ckbRpcUrl: string, public ckbIndexerUrl: string) {
    if (!ckbRpcUrl) {
      throw new Error(`CkbIndexer has to be constructed with a valid ckbRpcUrl (string). You passed: ${ckbRpcUrl}`);
    }

    if (!ckbIndexerUrl) {
      throw new Error(`CkbIndexer has to be constructed with a valid ckbRpcUrl (string). You passed: ${ckbIndexerUrl}`);
    }

    this.uri = ckbRpcUrl;
  }

  getCkbRpc(): RPC {
    return new RPC(this.ckbRpcUrl);
  }

  async tip(): Promise<Tip> {
    const res = await this.request('get_tip');
    return res as Tip;
  }

  async waitForSync(blockDifference = 0): Promise<void> {
    const rpcTipNumber = parseInt((await this.getCkbRpc().get_tip_header()).number, 16);
    logger.debug('rpcTipNumber', rpcTipNumber);
    let index = 0;
    while (true) {
      const indexerTipNumber = parseInt((await this.tip()).block_number, 16);
      logger.debug('indexerTipNumber', indexerTipNumber);
      if (indexerTipNumber + blockDifference >= rpcTipNumber) {
        return;
      }
      logger.debug(`wait until indexer sync. index: ${index++}`);
      await asyncSleep(1000);
    }
  }

  /*
   * Addtional note:
   * Only accept lock and type parameters as `Script` type, along with `data` field in QueryOptions. Use it carefully!
   * */
  collector(queries: QueryOptions): CellCollector {
    const { lock, type } = queries;
    let searchKey: SearchKey;
    if (lock !== undefined) {
      searchKey = {
        script: lock as Script,
        script_type: ScriptType.lock,
      };
      if (type != undefined && type !== 'empty') {
        searchKey.filter = {
          script: type as Script,
        };
      }
    } else {
      if (type != undefined && type != 'empty') {
        searchKey = {
          script: type as Script,
          script_type: ScriptType.type,
        };
      } else {
        throw new Error(
          `should specify either type or lock in queries, queries now: ${JSON.stringify(queries, null, 2)}`,
        );
      }
    }
    const queryData = queries.data || '0x';
    const request = this.request;
    const ckbIndexerUrl = this.ckbIndexerUrl;
    return {
      collect(): CellCollectorResults {
        return {
          async *[Symbol.asyncIterator]() {
            const order = 'asc';
            const sizeLimit = 100;
            let cursor = null;
            for (; ;) {
              const params: any = [searchKey, order, `0x${sizeLimit.toString(16)}`, cursor];
              logger.debug('get_cells params', params);
              const res = await request('get_cells', params, ckbIndexerUrl);
              const liveCells = res.objects;
              cursor = res.last_cursor;
              for (const cell of liveCells) {
                if (queryData === 'any' || queryData === cell.output_data) {
                  yield {
                    cell_output: cell.output,
                    data: cell.output_data,
                    out_point: cell.out_point,
                    block_number: cell.block_number,
                  };
                }
              }
              if (liveCells.length < sizeLimit) {
                break;
              }
            }
          },
        };
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  public async request(method: string, params?: any, ckbIndexerUrl: string = this.ckbIndexerUrl): Promise<any> {
    const jsonData = {
      id: 0,
      jsonrpc: '2.0',
      method,
      params,
    };
    try {
      const res = await axios.post(ckbIndexerUrl, jsonData);
      if (res.status !== 200) {
        console.warn('Error: ', res);
        throw new Error(`indexer request failed with HTTP code ${res.status}`);
      }
      return (res.data as any).result;
    } catch (err: any) {
      if ((err.response && err.response.data) || err.response.data.message) {
        throw new Error(method + 'Request Error' + err.response.data.message);
      }
      throw new Error(method + 'Request Error' + err.message);
    }
  }

  public async getCells(
    searchKey: SearchKey,
    terminator: Terminator = DefaultTerminator,
    { sizeLimit = 0x100, order = Order.asc }: { sizeLimit?: number; order?: Order } = {},
  ): Promise<Cell[]> {
    const infos: Cell[] = [];
    let cursor: string | undefined;
    const index = 0;
    while (true) {
      const params = [searchKey, order, `0x${sizeLimit.toString(16)}`, cursor];
      const res: GetLiveCellsResult = await this.request('get_cells', params);
      const liveCells = res.objects;
      cursor = res.last_cursor;
      logger.debug('liveCells', liveCells[liveCells.length - 1]);
      for (const liveCell of liveCells) {
        const cell: Cell = {
          cell_output: liveCell.output,
          data: liveCell.output_data,
          out_point: liveCell.out_point,
          block_number: liveCell.block_number,
        };
        const { stop, push } = terminator(index, cell);
        if (push) {
          infos.push(cell);
        }
        if (stop) {
          return infos;
        }
      }
      if (liveCells.length < sizeLimit) {
        break;
      }
    }
    return infos;
  }

  running(): boolean {
    return true;
  }

  start(): void {
    logger.debug('ckb indexer start');
  }

  startForever(): void {
    logger.debug('ckb indexer startForever');
  }

  stop(): void {
    logger.debug('ckb indexer stop');
  }

  //  eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe(queries: QueryOptions): NodeJS.EventEmitter {
    throw new Error('unimplemented');
  }

  subscribeMedianTime(): NodeJS.EventEmitter {
    throw new Error('unimplemented');
  }
}