import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PaymentStatus, ContributionStatus, Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { mkdir, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AuthModule } from '../src/auth/auth.module';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentsController } from '../src/payments/payments.controller';
import { PaymentsService } from '../src/payments/payments.service';
import { ReceiptStorageService } from '../src/payments/receipt-storage.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { MAX_RECEIPT_SIZE } from '../src/payments/receipt-file.pipe';

describe('Manual payment API (HTTP integration; mocked database, real receipt storage)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let directory: string;
  const root = '/committees/committee-1/payments';
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const contribution = {
    id: 'contribution-1',
    cycleId: 'cycle-1',
    memberId: 'member-1',
    amount: new Prisma.Decimal(5000),
    status: ContributionStatus.PENDING as ContributionStatus,
    cycle: { committeeId: 'committee-1', status: 'ACTIVE' },
    member: { userId: 'user-1', user: { id: 'user-1', name: 'Member' } },
  };
  type Receipt = {
    id: string;
    paymentId: string;
    mimeType: string;
    size: number;
    uploadedBy: string;
    uploadedAt: Date;
  };
  type Claim = {
    id: string;
    contributionId: string;
    memberId: string;
    amount: Prisma.Decimal;
    transactionReference: string;
    paymentMethod: string | null;
    status: PaymentStatus;
    receipt: Receipt | null;
    verifiedAt: Date | null;
    contribution: typeof contribution;
  };
  let claim: Claim | null;
  let collected: Prisma.Decimal;
  const prisma = {
    user: { findUnique: jest.fn() },
    committee: { findUnique: jest.fn() },
    committeeMember: { findUnique: jest.fn() },
    contribution: { findFirst: jest.fn(), updateMany: jest.fn() },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    paymentReceipt: { create: jest.fn() },
    cycle: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };

  const cookie = (id = 'user-1') => `jwt=${jwt.sign({ sub: id })}`;

  beforeAll(async () => {
    await mkdir(resolve('.tmp'), { recursive: true });
    directory = await mkdtemp(join(resolve('.tmp'), 'payment-receipts-test-'));
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_SECRET: 'payment-http-test-secret',
              PAYMENT_RECEIPTS_DIR: directory,
            }),
          ],
        }),
        PrismaModule,
        AuthModule,
      ],
      controllers: [PaymentsController],
      providers: [
        PaymentsService,
        ReceiptStorageService,
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    jwt = module.get(JwtService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    claim = null;
    collected = new Prisma.Decimal(0);
    contribution.status = ContributionStatus.PENDING;
    prisma.user.findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: where.id,
        email: 'test@example.com',
        role: where.id.includes('admin') ? 'ADMIN' : 'USER',
        status: 'ACTIVE',
      }),
    );
    prisma.committee.findUnique.mockResolvedValue({
      id: 'committee-1',
      createdBy: 'admin-1',
    });
    prisma.committeeMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.contribution.findFirst.mockResolvedValue(contribution);
    prisma.payment.findFirst.mockImplementation(
      async ({ where }: { where: { status?: PaymentStatus } }) =>
        !where.status || where.status === claim?.status ? claim : null,
    );
    prisma.payment.findUnique.mockImplementation(
      async () => claim && { contributionId: contribution.id },
    );
    prisma.payment.findUniqueOrThrow.mockImplementation(async () => {
      if (!claim) throw new Error('Missing claim');
      return claim;
    });
    prisma.payment.create.mockImplementation(
      async ({
        data,
      }: {
        data: Omit<Claim, 'id' | 'receipt' | 'verifiedAt' | 'contribution'>;
      }) => {
        claim = {
          ...data,
          id: 'payment-1',
          receipt: null,
          verifiedAt: null,
          contribution,
        };
        return claim;
      },
    );
    prisma.paymentReceipt.create.mockImplementation(
      async ({ data }: { data: Omit<Receipt, 'uploadedAt'> }) => {
        if (!claim) throw new Error('Missing claim');
        claim.receipt = { ...data, uploadedAt: new Date() };
        return claim.receipt;
      },
    );
    prisma.contribution.updateMany.mockImplementation(async () => {
      if (contribution.status === ContributionStatus.PAID) return { count: 0 };
      contribution.status = ContributionStatus.PAID;
      return { count: 1 };
    });
    prisma.cycle.updateMany.mockImplementation(
      async ({
        data,
      }: {
        data: { totalCollected: { increment: Prisma.Decimal } };
      }) => {
        collected = collected.plus(data.totalCollected.increment);
        return { count: 1 };
      },
    );
    prisma.payment.update.mockImplementation(
      async ({
        data,
      }: {
        data: { status: PaymentStatus; verifiedAt: Date };
      }) => {
        if (!claim) throw new Error('Missing claim');
        Object.assign(claim, data);
        return claim;
      },
    );
    prisma.$transaction.mockImplementation(
      (action: (tx: typeof prisma) => Promise<unknown>) => action(prisma),
    );
  });

  afterAll(async () => {
    await app?.close();
    if (directory) {
      for (const name of await readdir(directory))
        await unlink(join(directory, name));
      await rmdir(directory);
    }
  });

  async function createClaim() {
    return request(app.getHttpServer())
      .post(root)
      .set('Cookie', cookie())
      .send({
        contributionId: contribution.id,
        amount: 5000,
        transactionReference: '  REF-123  ',
        paymentMethod: 'EASYPAISA',
      })
      .expect(201);
  }

  function upload(
    id = 'user-1',
    buffer: Buffer = png,
    filename = 'receipt.png',
    contentType = 'image/png',
  ) {
    return request(app.getHttpServer())
      .post(`${root}/payment-1/receipt`)
      .set('Cookie', cookie(id))
      .attach('receipt', buffer, { filename, contentType });
  }

  it('submits, uploads, privately downloads and waits for admin approval before crediting dues', async () => {
    const created = await createClaim();
    expect(created.body).toMatchObject({
      status: 'PENDING',
      receipt: null,
      transactionReference: 'REF-123',
    });
    const uploaded = await upload().expect(201);
    expect(uploaded.body).toMatchObject({
      status: 'PENDING',
      receipt: { mimeType: 'image/png', size: png.length },
    });
    expect(contribution.status).toBe('PENDING');
    expect(collected.toString()).toBe('0');

    for (const user of ['user-1', 'admin-1']) {
      const downloaded = await request(app.getHttpServer())
        .get(`${root}/payment-1/receipt`)
        .set('Cookie', cookie(user))
        .expect(200);
      expect(downloaded.headers['content-type']).toMatch(/image\/png/);
      expect(downloaded.headers['cache-control']).toBe('private, no-store');
      expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
      expect(downloaded.body).toEqual(png);
    }
    const approved = await request(app.getHttpServer())
      .post(`${root}/payment-1/verify`)
      .set('Cookie', cookie('admin-1'))
      .expect(200);
    expect(approved.body).toMatchObject({
      status: 'VERIFIED',
      contribution: { status: 'PAID' },
    });
    expect(collected.toString()).toBe('5000');

    await request(app.getHttpServer())
      .post(`${root}/payment-1/verify`)
      .set('Cookie', cookie('admin-1'))
      .expect(400);
    expect(collected.toString()).toBe('5000');
  });

  it('requires a receipt before approval', async () => {
    await createClaim();
    await request(app.getHttpServer())
      .post(`${root}/payment-1/verify`)
      .set('Cookie', cookie('admin-1'))
      .expect(400);
    expect(collected.toString()).toBe('0');
  });

  it('prevents receipt access by another member or another committee admin', async () => {
    await createClaim();
    await upload().expect(201);
    for (const user of ['user-2', 'admin-2']) {
      await request(app.getHttpServer())
        .get(`${root}/payment-1/receipt`)
        .set('Cookie', cookie(user))
        .expect(403);
      await upload(user).expect(403);
    }
  });

  it('preserves receipts after rejection and leaves dues unpaid', async () => {
    await createClaim();
    await upload().expect(201);
    const rejected = await request(app.getHttpServer())
      .post(`${root}/payment-1/reject`)
      .set('Cookie', cookie('admin-1'))
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      receipt: { mimeType: 'image/png' },
    });
    expect(contribution.status).toBe('PENDING');
    expect(collected.toString()).toBe('0');
    await upload().expect(400);
    await request(app.getHttpServer())
      .get(`${root}/payment-1/receipt`)
      .set('Cookie', cookie())
      .expect(200);
  });

  it.each(['verify', 'reject'])(
    'blocks members from %s even their own payment',
    async (action) => {
      await createClaim();
      await request(app.getHttpServer())
        .post(`${root}/payment-1/${action}`)
        .set('Cookie', cookie())
        .expect(403);
    },
  );

  it('rejects missing receipt files', async () => {
    await createClaim();
    await request(app.getHttpServer())
      .post(`${root}/payment-1/receipt`)
      .set('Cookie', cookie())
      .expect(400);
  });

  it.each([
    [
      'fake PNG',
      Buffer.from('<html>not an image</html>'),
      'receipt.png',
      'image/png',
    ],
    ['SVG', Buffer.from('<svg></svg>'), 'receipt.svg', 'image/svg+xml'],
    ['PDF', Buffer.from('%PDF-1.4'), 'receipt.pdf', 'application/pdf'],
    ['MIME mismatch', png, 'receipt.jpg', 'image/jpeg'],
    ['empty file', Buffer.alloc(0), 'receipt.png', 'image/png'],
  ])('rejects %s', async (_label, data, name, type) => {
    await createClaim();
    await upload(
      'user-1',
      data as Buffer,
      name as string,
      type as string,
    ).expect(400);
    expect(prisma.paymentReceipt.create).not.toHaveBeenCalled();
  });

  it('limits uploads to 5 MiB', async () => {
    await createClaim();
    await upload('user-1', Buffer.alloc(MAX_RECEIPT_SIZE + 1)).expect(413);
    expect(prisma.paymentReceipt.create).not.toHaveBeenCalled();
  });

  it('rejects unexpected file fields and additional files', async () => {
    await createClaim();
    await request(app.getHttpServer())
      .post(`${root}/payment-1/receipt`)
      .set('Cookie', cookie())
      .attach('file', png, 'receipt.png')
      .expect(400);
    await request(app.getHttpServer())
      .post(`${root}/payment-1/receipt`)
      .set('Cookie', cookie())
      .attach('receipt', png, 'one.png')
      .attach('receipt', png, 'two.png')
      .expect(400);
  });

  it('rejects a supplied payment status on the upload endpoint', async () => {
    await createClaim();
    await request(app.getHttpServer())
      .post(`${root}/payment-1/receipt`)
      .set('Cookie', cookie())
      .field('status', 'VERIFIED')
      .attach('receipt', png, 'receipt.png')
      .expect(400);
    expect(contribution.status).toBe('PENDING');
  });

  it('rejects a supplied status on claim creation', async () => {
    await request(app.getHttpServer())
      .post(root)
      .set('Cookie', cookie())
      .send({
        contributionId: contribution.id,
        amount: 5000,
        transactionReference: 'REF',
        status: 'VERIFIED',
      })
      .expect(400);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('requires authentication for receipt upload and download', async () => {
    for (const method of ['get', 'post'] as const) {
      await request(app.getHttpServer())
        [method](`${root}/payment-1/receipt`)
        .expect(401);
      await request(app.getHttpServer())
        [method](`${root}/payment-1/receipt`)
        .set('Cookie', 'jwt=invalid')
        .expect(401);
    }
  });
});
