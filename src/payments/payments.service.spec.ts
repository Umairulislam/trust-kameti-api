import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReceiptStorageService } from './receipt-storage.service';

describe('PaymentsService', () => {
  const amount = new Prisma.Decimal(5000);
  const receipt = {
    id: 'receipt-1',
    mimeType: 'image/png',
    size: 100,
    uploadedAt: new Date(),
  };
  const file = { buffer: Buffer.from('image'), mimetype: 'image/png', size: 5 };
  const dto = {
    contributionId: 'contribution-1',
    amount: 5000,
    transactionReference: 'REF-1',
    paymentMethod: 'EASYPAISA' as const,
  };
  const committee = { id: 'committee-1', createdBy: 'admin-1' };
  const contribution = {
    id: 'contribution-1',
    cycleId: 'cycle-1',
    memberId: 'member-1',
    amount,
    status: 'PENDING',
    cycle: { committeeId: 'committee-1', status: 'ACTIVE' },
    member: { userId: 'user-1', user: { id: 'user-1' } },
  };
  const payment = {
    id: 'payment-1',
    contributionId: contribution.id,
    memberId: 'member-1',
    amount,
    status: 'PENDING',
    receipt,
    contribution,
  };
  const prisma = {
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
  const notifications = { create: jest.fn() };
  const storage = { save: jest.fn(), read: jest.fn(), remove: jest.fn() };
  const service = new PaymentsService(
    prisma as unknown as PrismaService,
    notifications as unknown as NotificationsService,
    storage as unknown as ReceiptStorageService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.committee.findUnique.mockResolvedValue(committee);
    prisma.committeeMember.findUnique.mockResolvedValue({
      id: 'member-1',
      status: 'ACTIVE',
    });
    prisma.contribution.findFirst.mockResolvedValue(contribution);
    prisma.contribution.updateMany.mockResolvedValue({ count: 1 });
    prisma.cycle.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.findFirst.mockResolvedValue(payment);
    prisma.payment.findUnique.mockResolvedValue({
      contributionId: contribution.id,
    });
    prisma.payment.findUniqueOrThrow.mockResolvedValue(payment);
    prisma.payment.create.mockResolvedValue({ ...payment, receipt: null });
    prisma.payment.update.mockResolvedValue({ ...payment, status: 'VERIFIED' });
    prisma.$transaction.mockImplementation(
      (action: (tx: typeof prisma) => Promise<unknown>) => action(prisma),
    );
    storage.save.mockResolvedValue(receipt);
    storage.read.mockResolvedValue(file.buffer);
  });

  describe('claim submission', () => {
    beforeEach(() => prisma.payment.findFirst.mockResolvedValue(null));

    it('creates a pending claim with the server amount and an audit record, without crediting dues', async () => {
      const result = await service.create(committee.id, dto, 'user-1');
      expect(result.status).toBe('PENDING');
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            amount,
            memberId: 'member-1',
            status: 'PENDING',
            paymentMethod: 'EASYPAISA',
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'PAYMENT_SUBMITTED',
            actorId: 'user-1',
          }),
        }),
      );
      expect(prisma.contribution.updateMany).not.toHaveBeenCalled();
      expect(prisma.cycle.updateMany).not.toHaveBeenCalled();
    });

    it('allows the organiser to record on behalf of the contribution member', async () => {
      await service.create(committee.id, dto, 'admin-1');
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ memberId: 'member-1' }),
        }),
      );
    });

    it('rejects another member submitting this contribution', async () => {
      await expect(
        service.create(committee.id, dto, 'other-user'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it.each(['INACTIVE', 'INVITED', 'REMOVED'])(
      'rejects %s membership',
      async (status) => {
        prisma.committeeMember.findUnique.mockResolvedValue({ status });
        await expect(
          service.create(committee.id, dto, 'user-1'),
        ).rejects.toThrow(ForbiddenException);
      },
    );

    it('rejects outsiders', async () => {
      prisma.committeeMember.findUnique.mockResolvedValue(null);
      await expect(
        service.create(committee.id, dto, 'outsider'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects missing contributions', async () => {
      prisma.contribution.findFirst.mockResolvedValue(null);
      await expect(service.create(committee.id, dto, 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects another committee contribution', async () => {
      prisma.contribution.findFirst.mockResolvedValue({
        ...contribution,
        cycle: { committeeId: 'other', status: 'ACTIVE' },
      });
      await expect(service.create(committee.id, dto, 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects paid contributions', async () => {
      prisma.contribution.findFirst.mockResolvedValue({
        ...contribution,
        status: 'PAID',
      });
      await expect(service.create(committee.id, dto, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts overdue contributions', async () => {
      prisma.contribution.findFirst.mockResolvedValue({
        ...contribution,
        status: 'OVERDUE',
      });
      await expect(
        service.create(committee.id, dto, 'user-1'),
      ).resolves.toHaveProperty('status', 'PENDING');
    });

    it.each([4999.99, 5000.01, 100])(
      'requires an exact amount: %s',
      async (value) => {
        await expect(
          service.create(committee.id, { ...dto, amount: value }, 'user-1'),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it.each(['COMPLETED', 'CANCELLED', 'UPCOMING'])(
      'rejects a %s cycle',
      async (status) => {
        prisma.contribution.findFirst.mockResolvedValue({
          ...contribution,
          cycle: { ...contribution.cycle, status },
        });
        await expect(
          service.create(committee.id, dto, 'user-1'),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('prevents multiple pending claims while allowing a fresh claim after rejection', async () => {
      prisma.payment.findFirst
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);
      await expect(service.create(committee.id, dto, 'user-1')).rejects.toThrow(
        ConflictException,
      );
      await expect(
        service.create(committee.id, dto, 'user-1'),
      ).resolves.toHaveProperty('status', 'PENDING');
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contributionId: contribution.id, status: 'PENDING' },
        }),
      );
    });
  });

  describe('receipts', () => {
    it('attaches a receipt and audits it without marking the payment paid', async () => {
      prisma.payment.findFirst.mockResolvedValue({ ...payment, receipt: null });
      prisma.payment.findUniqueOrThrow
        .mockResolvedValueOnce({ ...payment, receipt: null })
        .mockResolvedValueOnce(payment);
      const result = await service.uploadReceipt(
        committee.id,
        payment.id,
        'user-1',
        file,
      );
      expect(result.status).toBe('PENDING');
      expect(prisma.paymentReceipt.create).toHaveBeenCalledWith({
        data: {
          id: receipt.id,
          paymentId: payment.id,
          mimeType: receipt.mimeType,
          size: receipt.size,
          uploadedBy: 'user-1',
        },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'PAYMENT_RECEIPT_UPLOADED' }),
        }),
      );
      expect(prisma.contribution.updateMany).not.toHaveBeenCalled();
      expect(prisma.cycle.updateMany).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it.each(['user-1', 'admin-1'])(
      'allows %s to view the receipt',
      async (user) => {
        await expect(
          service.getReceipt(committee.id, payment.id, user),
        ).resolves.toEqual({
          buffer: file.buffer,
          mimeType: 'image/png',
        });
      },
    );

    it('blocks other members from viewing or uploading receipts', async () => {
      await expect(
        service.getReceipt(committee.id, payment.id, 'other-user'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.uploadReceipt(committee.id, payment.id, 'other-user', file),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.read).not.toHaveBeenCalled();
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('blocks cross-committee receipt access', async () => {
      prisma.payment.findFirst.mockResolvedValue({
        ...payment,
        contribution: {
          ...contribution,
          cycle: { ...contribution.cycle, committeeId: 'another' },
        },
      });
      await expect(
        service.getReceipt(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns 404 when there is no receipt', async () => {
      prisma.payment.findFirst.mockResolvedValue({ ...payment, receipt: null });
      await expect(
        service.getReceipt(committee.id, payment.id, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not replace an existing receipt', async () => {
      await expect(
        service.uploadReceipt(committee.id, payment.id, 'user-1', file),
      ).rejects.toThrow(ConflictException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it.each(['VERIFIED', 'REJECTED'])(
      'does not upload to a %s claim',
      async (status) => {
        prisma.payment.findFirst.mockResolvedValue({
          ...payment,
          status,
          receipt: null,
        });
        await expect(
          service.uploadReceipt(committee.id, payment.id, 'user-1', file),
        ).rejects.toThrow(BadRequestException);
        expect(storage.save).not.toHaveBeenCalled();
      },
    );

    it('cleans up a saved file when a competing upload already attached a receipt', async () => {
      prisma.payment.findFirst.mockResolvedValue({ ...payment, receipt: null });
      await expect(
        service.uploadReceipt(committee.id, payment.id, 'user-1', file),
      ).rejects.toThrow(ConflictException);
      expect(storage.remove).toHaveBeenCalledWith(receipt.id);
    });

    it('cleans up a saved file when the audit write fails', async () => {
      prisma.payment.findFirst.mockResolvedValue({ ...payment, receipt: null });
      prisma.payment.findUniqueOrThrow.mockResolvedValue({
        ...payment,
        receipt: null,
      });
      prisma.auditLog.create.mockRejectedValue(new Error('database failure'));
      await expect(
        service.uploadReceipt(committee.id, payment.id, 'user-1', file),
      ).rejects.toThrow('database failure');
      expect(storage.remove).toHaveBeenCalledWith(receipt.id);
    });
  });

  describe('admin decisions', () => {
    it('credits dues and cycle totals, verifies, and audits within one transaction', async () => {
      await service.verify(committee.id, payment.id, 'admin-1');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.contribution.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: contribution.id, status: { not: 'PAID' } },
          data: expect.objectContaining({
            status: 'PAID',
            paymentId: payment.id,
          }),
        }),
      );
      expect(prisma.cycle.updateMany).toHaveBeenCalledWith({
        where: { id: contribution.cycleId, status: 'ACTIVE' },
        data: { totalCollected: { increment: amount } },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorId: 'admin-1',
            action: 'PAYMENT_VERIFIED',
          }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledTimes(1);
    });

    it('credits only once when approval requests overlap', async () => {
      let credited = false;
      prisma.contribution.updateMany.mockImplementation(async () => {
        if (credited) return { count: 0 };
        credited = true;
        return { count: 1 };
      });
      const results = await Promise.allSettled([
        service.verify(committee.id, payment.id, 'admin-1'),
        service.verify(committee.id, payment.id, 'admin-1'),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      expect(prisma.cycle.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('cannot approve a claim without a receipt', async () => {
      prisma.payment.findUniqueOrThrow.mockResolvedValue({
        ...payment,
        receipt: null,
      });
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.contribution.updateMany).not.toHaveBeenCalled();
    });

    it('cannot credit an obligation already settled by another claim', async () => {
      prisma.contribution.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.cycle.updateMany).not.toHaveBeenCalled();
      expect(prisma.payment.update).not.toHaveBeenCalled();
    });

    it('cannot approve against a closed cycle', async () => {
      prisma.cycle.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.payment.update).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('checks the persisted payment amount before approval', async () => {
      prisma.payment.findUniqueOrThrow.mockResolvedValue({
        ...payment,
        amount: new Prisma.Decimal(1),
      });
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.contribution.updateMany).not.toHaveBeenCalled();
    });

    it.each(['verify', 'reject'] as const)(
      'requires the committee owner to %s',
      async (method) => {
        await expect(
          service[method](committee.id, payment.id, 'user-1'),
        ).rejects.toThrow(ForbiddenException);
        await expect(
          service[method](committee.id, payment.id, 'other-admin'),
        ).rejects.toThrow(ForbiddenException);
      },
    );

    it.each(['VERIFIED', 'REJECTED'])(
      'cannot decide a %s payment again',
      async (status) => {
        prisma.payment.findUniqueOrThrow.mockResolvedValue({
          ...payment,
          status,
        });
        await expect(
          service.verify(committee.id, payment.id, 'admin-1'),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.reject(committee.id, payment.id, 'admin-1'),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.contribution.updateMany).not.toHaveBeenCalled();
      },
    );

    it('rejects missing payments', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects without changing dues, totals or receipt history', async () => {
      prisma.payment.update.mockResolvedValue({
        ...payment,
        status: 'REJECTED',
      });
      await expect(
        service.reject(committee.id, payment.id, 'admin-1'),
      ).resolves.toHaveProperty('status', 'REJECTED');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'PAYMENT_REJECTED' }),
        }),
      );
      expect(prisma.contribution.updateMany).not.toHaveBeenCalled();
      expect(prisma.cycle.updateMany).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('propagates audit failures without sending a success notification', async () => {
      prisma.auditLog.create.mockRejectedValue(new Error('audit failed'));
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).rejects.toThrow('audit failed');
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('does not report a committed payment as failed when notification delivery fails', async () => {
      notifications.create.mockRejectedValue(new Error('notification failure'));
      await expect(
        service.verify(committee.id, payment.id, 'admin-1'),
      ).resolves.toHaveProperty('status', 'VERIFIED');
    });
  });

  it('lists committee payments with status and pagination', async () => {
    prisma.payment.findMany.mockResolvedValue([payment]);
    prisma.payment.count.mockResolvedValue(1);
    await expect(
      service.findAll(
        committee.id,
        { status: 'PENDING', page: 2, limit: 5 },
        'admin-1',
      ),
    ).resolves.toMatchObject({ total: 1, page: 2, limit: 5 });
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contribution: { cycle: { committeeId: committee.id } },
          status: 'PENDING',
        },
        skip: 5,
        take: 5,
      }),
    );
  });

  it('returns 404 for missing committees and payments', async () => {
    prisma.committee.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.findOne(committee.id, payment.id, 'user-1'),
    ).rejects.toThrow(NotFoundException);
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(
      service.findOne(committee.id, payment.id, 'user-1'),
    ).rejects.toThrow(NotFoundException);
  });
});
