const redisMembers = new Map<string, Set<string>>();

jest.mock('../../utils/redis.utils', () => ({
   getRedis: () => ({
      sadd: jest.fn(async (key: string, member: string) => {
         const set = redisMembers.get(key) ?? new Set<string>();
         const wasNew = !set.has(member);
         if (wasNew) {
            set.add(member);
            redisMembers.set(key, set);
         }
         return wasNew ? 1 : 0;
      }),
   }),
}));

const prismaMock = {
   keyOwnership: {
      findMany: jest.fn(),
      count: jest.fn(),
   },
   activityLog: {
      create: jest.fn(),
   },
   creatorProfile: {
      findFirst: jest.fn(),
      update: jest.fn(),
   },
   $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
};

jest.mock('../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

jest.mock('../../utils/audit.utils', () => ({
   emitAuditEvent: jest.fn(),
}));

jest.mock('../admin/audit-log.service', () => ({
   createAuditEntry: jest.fn(),
}));

import { dispatchKeySunsetNotifications } from './key-deprecation.service';

describe('dispatchKeySunsetNotifications', () => {
   beforeEach(() => {
      redisMembers.clear();
      jest.clearAllMocks();
   });

   it('dispatches to all holders with sunset deadline and buyback price', async () => {
      prismaMock.keyOwnership.findMany.mockResolvedValue([
         { ownerAddress: 'GAAAAAA1' },
         { ownerAddress: 'GAAAAAA2' },
      ]);
      const dispatcher = jest
         .fn()
         .mockResolvedValue(undefined);

      const result = await dispatchKeySunsetNotifications({
         keyId: 'creator-1',
         eventId: 'sunset-event-1',
         sunsetDeadline: new Date('2026-12-31T00:00:00.000Z'),
         buybackPriceXlm: '12.50',
         actor: 'system',
         notificationDispatcher: dispatcher,
      });

      expect(dispatcher).toHaveBeenCalledTimes(2);
      expect(result.deliveredCount).toBe(2);
      expect(result.failedCount).toBe(0);
      expect(result.holdersNotified).toBe(2);
      expect(dispatcher.mock.calls[0][0]).toMatchObject({
         eventType: 'key_sunset_flagged',
         keyId: 'creator-1',
         buybackPriceXlm: '12.50',
         sunsetDeadline: '2026-12-31T00:00:00.000Z',
      });
      expect(prismaMock.activityLog.create).toHaveBeenCalledTimes(2);
   });

   it('prevents duplicate notifications for the same sunset event', async () => {
      prismaMock.keyOwnership.findMany.mockResolvedValue([
         { ownerAddress: 'GAAAAAA3' },
         { ownerAddress: 'GAAAAAA4' },
      ]);
      const dispatcher = jest.fn().mockResolvedValue(undefined);

      const first = await dispatchKeySunsetNotifications({
         keyId: 'creator-2',
         eventId: 'sunset-event-duplicate',
         sunsetDeadline: new Date('2026-11-01T00:00:00.000Z'),
         buybackPriceXlm: '9.25',
         actor: 'system',
         notificationDispatcher: dispatcher,
      });
      const second = await dispatchKeySunsetNotifications({
         keyId: 'creator-2',
         eventId: 'sunset-event-duplicate',
         sunsetDeadline: new Date('2026-11-01T00:00:00.000Z'),
         buybackPriceXlm: '9.25',
         actor: 'system',
         notificationDispatcher: dispatcher,
      });

      expect(first.deliveredCount).toBe(2);
      expect(second.skippedCount).toBe(2);
      expect(dispatcher).toHaveBeenCalledTimes(2);
      expect(second.dispatches.every(item => item.status === 'skipped')).toBe(true);
   });

   it('retries each failed dispatch up to the configured retry limit', async () => {
      prismaMock.keyOwnership.findMany.mockResolvedValue([
         { ownerAddress: 'GAAAAAA5' },
      ]);
      const dispatcher = jest
         .fn()
         .mockRejectedValueOnce(new Error('transient failure'))
         .mockRejectedValueOnce(new Error('transient failure'))
         .mockResolvedValueOnce(undefined);

      const result = await dispatchKeySunsetNotifications({
         keyId: 'creator-3',
         eventId: 'sunset-event-retry',
         sunsetDeadline: new Date('2026-10-15T00:00:00.000Z'),
         buybackPriceXlm: '7.00',
         maxRetries: 3,
         actor: 'system',
         notificationDispatcher: dispatcher,
      });

      expect(dispatcher).toHaveBeenCalledTimes(3);
      expect(result.deliveredCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.dispatches[0]).toMatchObject({
         holderAddress: 'GAAAAAA5',
         status: 'delivered',
         attempts: 3,
      });
   });

   it('records delivery status per holder in the dispatch log', async () => {
      prismaMock.keyOwnership.findMany.mockResolvedValue([
         { ownerAddress: 'GAAAAAA6' },
      ]);
      const dispatcher = jest.fn().mockRejectedValue(new Error('permanent failure'));

      const result = await dispatchKeySunsetNotifications({
         keyId: 'creator-4',
         eventId: 'sunset-event-log',
         sunsetDeadline: new Date('2026-09-30T00:00:00.000Z'),
         buybackPriceXlm: '4.00',
         maxRetries: 3,
         actor: 'system',
         notificationDispatcher: dispatcher,
      });

      expect(result.dispatches[0]).toMatchObject({
         holderAddress: 'GAAAAAA6',
         status: 'failed',
         attempts: 3,
      });
      expect(prismaMock.activityLog.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               type: 'key_sunset_flagged_notification',
               target: 'GAAAAAA6',
               payload: expect.objectContaining({
                  status: 'failed',
                  attempts: 3,
                  eventId: 'sunset-event-log',
               }),
            }),
         })
      );
   });
});
