import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  PipeTransform,
} from '@nestjs/common';

export const MAX_RECEIPT_SIZE = 5 * 1024 * 1024;

export interface ReceiptFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

@Injectable()
export class ReceiptFilePipe implements PipeTransform<
  ReceiptFile | undefined,
  ReceiptFile
> {
  transform(file: ReceiptFile | undefined): ReceiptFile {
    if (!file?.buffer?.length) {
      throw new BadRequestException('A receipt image is required');
    }
    if (file.buffer.length > MAX_RECEIPT_SIZE) {
      throw new PayloadTooLargeException('Receipt must not exceed 5 MiB');
    }

    // Check file signatures as well as the untrusted multipart MIME type.
    const png =
      file.buffer.length >= 33 &&
      file.buffer
        .subarray(0, 8)
        .equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      file.buffer.subarray(12, 16).toString('ascii') === 'IHDR' &&
      file.buffer
        .subarray(-12)
        .equals(Buffer.from('0000000049454e44ae426082', 'hex'));
    const jpeg =
      file.buffer.length >= 4 &&
      file.buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) &&
      file.buffer.subarray(-2).equals(Buffer.from('ffd9', 'hex'));

    if (
      !(png && file.mimetype === 'image/png') &&
      !(jpeg && file.mimetype === 'image/jpeg')
    ) {
      throw new BadRequestException('Receipt must be a PNG or JPEG image');
    }

    return { ...file, size: file.buffer.length };
  }
}
