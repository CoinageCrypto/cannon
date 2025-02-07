import { CannonLoader, IPFSLoader } from '@usecannon/builder';

import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import { CliSettings } from './settings';
import { DEFAULT_REGISTRY_IPFS_ENDPOINT } from './constants';
import debug from 'debug';

export class LocalLoader implements CannonLoader {
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  getLabel(): string {
    return `local (${this.dir})`;
  }

  read(url: string): Promise<any> {
    if (!url.startsWith('file://')) {
      throw new Error('incorrect url type');
    }

    return fs.readJson(path.join(this.dir, `${url.slice(7)}`));
  }

  async put(misc: any): Promise<string | null> {
    const dataToSave = JSON.stringify(misc);
    const hash = crypto.createHash('md5').update(dataToSave).digest('hex');

    await fs.mkdirp(this.dir);
    await fs.writeFile(path.join(this.dir, `${hash}.json`), dataToSave);

    return `file://${hash}.json`;
  }

  async list() {
    debug('local list');

    return (await fs.readdir(this.dir)).filter((f) => f.match(/[0-9a-f]+\.json/)).map((f) => `file://${f}`);
  }

  async remove(url: string) {
    debug(`local remove ${url}`);

    await fs.unlink(path.join(this.dir, `${url.slice(7)}`));
  }
}

export function getMainLoader(cliSettings: CliSettings) {
  return {
    ipfs: new IPFSLoader(cliSettings.ipfsUrl || DEFAULT_REGISTRY_IPFS_ENDPOINT),
    file: new LocalLoader(path.join(cliSettings.cannonDirectory, 'blobs')),
  };
}
