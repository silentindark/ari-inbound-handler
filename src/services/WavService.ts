import { infoByFilename } from 'wav-file-info';
import { logger } from '../misc/Logger';

export class WavService {
  static async asyncInfoByFilename(filepath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      infoByFilename(filepath, (err: Error | undefined, info: { duration: number }) => {
        if (err) {
          reject(err);
        } else {
          resolve(info.duration);
        }
      });
    });
  }

  static async getWavFileDuration(filepath: string): Promise<number> {
    try {
      // FIXME: remove directoryPrefix
      const duration = await this.asyncInfoByFilename(`/Users/sptm/OrbStack/asterisk20${filepath}`);
      return Math.ceil(duration);
    } catch (err) {
      logger.error(`Error reading WAV file ${filepath}: ${err.message}`);
      return 0;
    }
  }
}
