import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ReceiptFile } from './receipt-file.pipe';

@Injectable()
export class ReceiptStorageService {
  private readonly directory: string;
  private readonly logger = new Logger(ReceiptStorageService.name);

  constructor(config: ConfigService) {
    this.directory = resolve(
      config.get<string>('PAYMENT_RECEIPTS_DIR') || 'uploads/payment-receipts',
    );
  }

  async save(file: ReceiptFile) {
    const id = randomUUID();
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.path(id), file.buffer, { flag: 'wx', mode: 0o600 });
    } catch {
      await this.remove(id);
      throw new InternalServerErrorException('Unable to store receipt');
    }
    return { id, mimeType: file.mimetype, size: file.buffer.length };
  }

  async read(id: string): Promise<Buffer> {
    try {
      return await readFile(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Receipt file not found');
      }
      throw new InternalServerErrorException('Unable to read receipt');
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('Unable to clean up an unlinked receipt file');
      }
    }
  }

  private path(id: string): string {
    // Only server-generated identifiers may resolve into the private storage directory.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new InternalServerErrorException('Invalid receipt identifier');
    }
    return join(this.directory, id);
  }
}
