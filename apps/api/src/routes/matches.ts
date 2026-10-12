import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentUser, requireUser } from '../auth/guards.js';
import type { AppDeps } from '../core/deps.js';
import { parse } from '../core/validate.js';
import * as matches from '../modules/matches/service.js';

const IdParam = z.strictObject({ id: z.uuid() });
const ModeFormat = z.strictObject({
  mode: z.enum(['h2h', 'teams', 'ffa']),
  format: z.enum(['classic', 'speed']),
  bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});

export function registerMatchRoutes(app: FastifyInstance, deps: AppDeps): void {
  const user = { preHandler: requireUser };
  const guessing = {
    preHandler: requireUser,
    config: {
      rateLimit: {
        max: deps.answerRateLimit.max,
        timeWindow: deps.answerRateLimit.timeWindowMs,
        keyGenerator: (req: FastifyRequest) => req.auth?.userId ?? req.ip,
      },
    },
  };

  // Private rooms
  app.post('/matches/rooms', user, async (req, reply) =>
    reply
      .code(201)
      .send(await matches.createRoom(deps, currentUser(req).userId, parse(ModeFormat, req.body))),
  );
  app.post('/matches/rooms/join', user, async (req) => {
    const { code } = parse(z.strictObject({ code: z.string().min(4).max(12) }), req.body);
    return matches.joinRoom(deps, currentUser(req).userId, code);
  });
  app.post('/matches/:id/team', user, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { team } = parse(
      z.strictObject({ team: z.union([z.literal(0), z.literal(1)]) }),
      req.body,
    );
    return matches.chooseTeam(deps, currentUser(req).userId, id, team);
  });
  app.post('/matches/:id/start', user, async (req) => {
    const { id } = parse(IdParam, req.params);
    return matches.startRoom(deps, currentUser(req).userId, id);
  });
  app.post('/matches/:id/leave-lobby', user, async (req) => {
    const { id } = parse(IdParam, req.params);
    return matches.leaveLobby(deps, currentUser(req).userId, id);
  });

  // Public matchmaking
  app.post('/matchmaking/queue', user, async (req) =>
    matches.enqueue(deps, currentUser(req).userId, parse(ModeFormat, req.body)),
  );
  app.delete('/matchmaking/queue', user, async (req) =>
    matches.cancelQueue(deps, currentUser(req).userId),
  );
  app.get('/matchmaking/queue', user, async (req) =>
    matches.queueStatus(deps, currentUser(req).userId),
  );

  // Playing
  app.get('/matches/current', user, async (req) => ({
    matchId: await matches.currentMatchId(deps, currentUser(req).userId),
  }));
  app.get('/matches/:id', user, async (req) => {
    const { id } = parse(IdParam, req.params);
    return matches.getMatchView(deps, currentUser(req).userId, id);
  });
  app.post('/matches/:id/guesses', guessing, async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(
      z.strictObject({ text: z.string().max(200), clientRequestId: z.string().min(8).max(100) }),
      req.body,
    );
    return matches.submitMatchGuess(
      deps,
      currentUser(req).userId,
      id,
      body.text,
      body.clientRequestId,
    );
  });

  /**
   * Live updates. Signed-in users subscribe to matches they play in; messages carry only ids,
   * and the client fetches its own view over HTTP (so privacy rules apply in one place).
   */
  app.get('/ws', { websocket: true, preHandler: requireUser }, (socket, req) => {
    const userId = currentUser(req).userId;
    const offs: (() => void)[] = [
      deps.events.onUser(userId, (e) => socket.send(JSON.stringify(e))),
    ];
    socket.on('message', async (raw: Buffer) => {
      try {
        const msg = z.strictObject({ subscribe: z.uuid() }).parse(JSON.parse(raw.toString()));
        const member = await deps.db
          .selectFrom('match_players')
          .select('user_id')
          .where('match_id', '=', msg.subscribe)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!member) return socket.send(JSON.stringify({ type: 'error', code: 'NOT_FOUND' }));
        offs.push(deps.events.onMatch(msg.subscribe, (e) => socket.send(JSON.stringify(e))));
        socket.send(JSON.stringify({ type: 'subscribed', matchId: msg.subscribe }));
      } catch {
        socket.send(JSON.stringify({ type: 'error', code: 'BAD_MESSAGE' }));
      }
    });
    socket.on('close', () => offs.forEach((off) => off()));
  });
}
