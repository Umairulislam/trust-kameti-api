import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import {
  Committee,
  ContributionStatus,
  NotificationType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { QueryPaymentDto } from './dto/query-payment.dto';
import { ReceiptFile } from './receipt-file.pipe';
import { ReceiptStorageService } from './receipt-storage.service';

const PAYMENT_INCLUDE = {
  receipt: {
    select: { id: true, mimeType: true, size: true, uploadedAt: true },
  },
  contribution: {
    select: {
      id: true,
      cycleId: true,
      memberId: true,
      amount: true,
      status: true,
      cycle: { select: { committeeId: true, status: true } },
      member: {
        select: {
          id: true,
          role: true,
          status: true,
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

type PaymentWithContribution = Prisma.PaymentGetPayload<{
  include: typeof PAYMENT_INCLUDE;
}>;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly receiptStorage: ReceiptStorageService,
  ) {}

  async create(
    committeeId: string,
    dto: CreatePaymentDto,
    userId: string,
  ): Promise<PaymentWithContribution> {
    const committee = await this.requireCommitteeAccess(committeeId, userId);

    return this.prisma.$transaction(async (tx) => {
      await this.lockContribution(tx, dto.contributionId);
      const contribution = await tx.contribution.findFirst({
        where: { id: dto.contributionId },
        include: {
          cycle: { select: { committeeId: true, status: true } },
          member: { select: { userId: true } },
        },
      });

      if (!contribution) throw new NotFoundException('Contribution not found');
      if (contribution.cycle.committeeId !== committeeId) {
        throw new ForbiddenException(
          'Contribution does not belong to this committee',
        );
      }
      if (
        committee.createdBy !== userId &&
        contribution.member.userId !== userId
      ) {
        throw new ForbiddenException(
          'You can only submit payments for your own contributions',
        );
      }
      if (contribution.status === ContributionStatus.PAID) {
        throw new BadRequestException('Contribution is already paid');
      }
      if (contribution.cycle.status !== 'ACTIVE') {
        throw new BadRequestException('Payments require an active cycle');
      }
      if (!contribution.amount.equals(dto.amount)) {
        throw new BadRequestException(
          `Payment amount must match contribution amount of ${contribution.amount.toString()}`,
        );
      }

      const pending = await tx.payment.findFirst({
        where: {
          contributionId: contribution.id,
          status: PaymentStatus.PENDING,
        },
        select: { id: true },
      });
      if (pending) {
        throw new ConflictException(
          'A pending payment already exists for this contribution',
        );
      }

      const payment = await tx.payment.create({
        data: {
          contributionId: contribution.id,
          memberId: contribution.memberId,
          amount: contribution.amount,
          transactionReference: dto.transactionReference,
          paymentMethod: dto.paymentMethod,
          status: PaymentStatus.PENDING,
        },
        include: PAYMENT_INCLUDE,
      });
      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: 'PAYMENT_SUBMITTED',
          entityType: 'Payment',
          entityId: payment.id,
          committeeId,
          cycleId: contribution.cycleId,
          metadata: {
            contributionId: contribution.id,
            amount: contribution.amount.toString(),
          },
        },
      });
      return payment;
    });
  }

  async findAll(
    committeeId: string,
    query: QueryPaymentDto,
    userId: string,
  ): Promise<{
    data: PaymentWithContribution[];
    total: number;
    page: number;
    limit: number;
  }> {
    await this.requireCommitteeAccess(committeeId, userId);
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const where: Prisma.PaymentWhereInput = {
      contribution: { cycle: { committeeId } },
      status: query.status,
    };
    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        include: PAYMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async findOne(
    committeeId: string,
    id: string,
    userId: string,
  ): Promise<PaymentWithContribution> {
    await this.requireCommitteeAccess(committeeId, userId);
    const payment = await this.prisma.payment.findFirst({
      where: { id },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    this.assertPaymentCommittee(payment, committeeId);
    return payment;
  }

  async uploadReceipt(
    committeeId: string,
    id: string,
    userId: string,
    file: ReceiptFile,
  ): Promise<PaymentWithContribution> {
    const payment = await this.requireReceiptAccess(committeeId, id, userId);
    this.assertPending(payment);
    if (payment.receipt) {
      throw new ConflictException(
        'A receipt is already attached; existing evidence cannot be replaced',
      );
    }

    const stored = await this.receiptStorage.save(file);
    try {
      return await this.withPendingPayment(
        committeeId,
        id,
        async (tx, current) => {
          if (current.receipt) {
            throw new ConflictException(
              'A receipt is already attached; existing evidence cannot be replaced',
            );
          }
          if (current.contribution.status === ContributionStatus.PAID) {
            throw new BadRequestException('Contribution is already paid');
          }
          if (current.contribution.cycle.status !== 'ACTIVE') {
            throw new BadRequestException('Payments require an active cycle');
          }
          await tx.paymentReceipt.create({
            data: {
              id: stored.id,
              paymentId: id,
              mimeType: stored.mimeType,
              size: stored.size,
              uploadedBy: userId,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: userId,
              action: 'PAYMENT_RECEIPT_UPLOADED',
              entityType: 'Payment',
              entityId: id,
              committeeId,
              cycleId: current.contribution.cycleId,
              metadata: { receiptId: stored.id },
            },
          });
          return tx.payment.findUniqueOrThrow({
            where: { id },
            include: PAYMENT_INCLUDE,
          });
        },
      );
    } catch (error) {
      await this.receiptStorage.remove(stored.id);
      throw error;
    }
  }

  async getReceipt(committeeId: string, id: string, userId: string) {
    const payment = await this.requireReceiptAccess(committeeId, id, userId);
    if (!payment.receipt) throw new NotFoundException('Receipt not found');
    const buffer = await this.receiptStorage.read(payment.receipt.id);
    return { buffer, mimeType: payment.receipt.mimeType };
  }

  async verify(
    committeeId: string,
    id: string,
    userId: string,
  ): Promise<PaymentWithContribution> {
    await this.requireOwnedCommittee(committeeId, userId);
    const verified = await this.withPendingPayment(
      committeeId,
      id,
      async (tx, payment) => {
        if (!payment.receipt) {
          throw new BadRequestException(
            'Upload a receipt before approving this payment',
          );
        }
        if (!payment.amount.equals(payment.contribution.amount)) {
          throw new BadRequestException(
            'Payment amount does not match the contribution',
          );
        }

        const now = new Date();
        // Conditional writes protect against other financial operations as well as repeated approvals.
        const contribution = await tx.contribution.updateMany({
          where: {
            id: payment.contributionId,
            status: { not: ContributionStatus.PAID },
          },
          data: { status: ContributionStatus.PAID, paidAt: now, paymentId: id },
        });
        if (contribution.count !== 1) {
          throw new ConflictException('Contribution is already paid');
        }
        const cycle = await tx.cycle.updateMany({
          where: { id: payment.contribution.cycleId, status: 'ACTIVE' },
          data: { totalCollected: { increment: payment.amount } },
        });
        if (cycle.count !== 1) {
          throw new BadRequestException('Payments require an active cycle');
        }
        const result = await tx.payment.update({
          where: { id },
          data: { status: PaymentStatus.VERIFIED, verifiedAt: now },
          include: PAYMENT_INCLUDE,
        });
        await tx.auditLog.create({
          data: {
            actorId: userId,
            action: 'PAYMENT_VERIFIED',
            entityType: 'Payment',
            entityId: id,
            committeeId,
            cycleId: payment.contribution.cycleId,
            metadata: {
              amount: payment.amount.toString(),
              contributionId: payment.contributionId,
            },
          },
        });
        return result;
      },
    );
    await this.notifyPayment(verified, committeeId, true);
    return verified;
  }

  async reject(
    committeeId: string,
    id: string,
    userId: string,
  ): Promise<PaymentWithContribution> {
    await this.requireOwnedCommittee(committeeId, userId);
    const rejected = await this.withPendingPayment(
      committeeId,
      id,
      async (tx, payment) => {
        const result = await tx.payment.update({
          where: { id },
          data: { status: PaymentStatus.REJECTED, verifiedAt: new Date() },
          include: PAYMENT_INCLUDE,
        });
        await tx.auditLog.create({
          data: {
            actorId: userId,
            action: 'PAYMENT_REJECTED',
            entityType: 'Payment',
            entityId: id,
            committeeId,
            cycleId: payment.contribution.cycleId,
            metadata: { amount: payment.amount.toString() },
          },
        });
        return result;
      },
    );
    await this.notifyPayment(rejected, committeeId, false);
    return rejected;
  }

  private async withPendingPayment<T>(
    committeeId: string,
    id: string,
    action: (
      tx: Prisma.TransactionClient,
      payment: PaymentWithContribution,
    ) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const reference = await tx.payment.findUnique({
        where: { id },
        select: { contributionId: true },
      });
      if (!reference) throw new NotFoundException('Payment not found');
      await this.lockContribution(tx, reference.contributionId);
      const payment = await tx.payment.findUniqueOrThrow({
        where: { id },
        include: PAYMENT_INCLUDE,
      });
      this.assertPaymentCommittee(payment, committeeId);
      this.assertPending(payment);
      return action(tx, payment);
    });
  }

  private async lockContribution(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    // Serialise claims, receipt uploads and decisions for the same obligation.
    await tx.$queryRaw`SELECT "id" FROM "contributions" WHERE "id" = ${id} FOR UPDATE`;
  }

  private assertPending(payment: PaymentWithContribution): void {
    if (payment.status !== PaymentStatus.PENDING) {
      throw new BadRequestException(
        `Payment is already ${payment.status}. Only PENDING payments can be changed.`,
      );
    }
  }

  private assertPaymentCommittee(
    payment: PaymentWithContribution,
    committeeId: string,
  ): void {
    if (payment.contribution.cycle.committeeId !== committeeId) {
      throw new ForbiddenException('Payment does not belong to this committee');
    }
  }

  private async requireReceiptAccess(
    committeeId: string,
    id: string,
    userId: string,
  ): Promise<PaymentWithContribution> {
    const committee = await this.requireCommitteeAccess(committeeId, userId);
    const payment = await this.prisma.payment.findFirst({
      where: { id },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    this.assertPaymentCommittee(payment, committeeId);
    if (
      committee.createdBy !== userId &&
      payment.contribution.member.user.id !== userId
    ) {
      throw new ForbiddenException(
        'Only the paying member and committee admin can access the receipt',
      );
    }
    return payment;
  }

  private async requireOwnedCommittee(
    committeeId: string,
    userId: string,
  ): Promise<Committee> {
    const committee = await this.prisma.committee.findUnique({
      where: { id: committeeId },
    });
    if (!committee) throw new NotFoundException('Committee not found');
    if (committee.createdBy !== userId) {
      throw new ForbiddenException(
        'Only the committee admin can perform this action',
      );
    }
    return committee;
  }

  private async requireCommitteeAccess(
    committeeId: string,
    userId: string,
  ): Promise<Committee> {
    const committee = await this.prisma.committee.findUnique({
      where: { id: committeeId },
    });
    if (!committee) throw new NotFoundException('Committee not found');
    if (committee.createdBy === userId) return committee;
    const membership = await this.prisma.committeeMember.findUnique({
      where: { userId_committeeId: { userId, committeeId } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('You do not have access to this committee');
    }
    return committee;
  }

  private async notifyPayment(
    payment: PaymentWithContribution,
    committeeId: string,
    verified: boolean,
  ): Promise<void> {
    try {
      await this.notificationsService.create({
        userId: payment.contribution.member.user.id,
        type: verified
          ? NotificationType.PAYMENT_VERIFIED
          : NotificationType.PAYMENT_REJECTED,
        title: verified ? 'Payment Verified' : 'Payment Rejected',
        message: verified
          ? `Your payment of ${payment.amount.toString()} has been verified.`
          : `Your payment of ${payment.amount.toString()} has been rejected. Please contact the committee admin for details.`,
        committeeId,
      });
    } catch {
      // The financial transaction has committed; notification failure must not report it as failed.
      this.logger.warn(
        'Payment decision saved, but member notification could not be delivered',
      );
    }
  }
}
