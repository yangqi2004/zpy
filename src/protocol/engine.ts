/*
 * the engine interface defines how the application being managed by the server
 * deals with state transitions as users join, leave, and otherwise interact.
 * it also encodes the way the game requires information to be hidden.
 *
 * the types State and Action define the game state and possible transitions,
 * respectively; while ClientState and ClientAction define the state and
 * possible transitions as they are visible by a particular user.
 *
 * the functions redact and redact_action define the mapping from the
 * globally-knowledgeable State and Action to their client-side counterparts.
 * protocol actions should be viewed as if they redact to themselves.
 *
 * the functions apply and apply_client define the way that actions affect a
 * given game state.
 *
 * in particular, this diagram commutes:
 *
 *  Intent
 *     |    \
 *     |     \
 *  listen     predict
 *     |               \____________
 *     |                            |
 *     v                            v
 *  Action ----redact_action----> Effect
 *     |                            |
 *     |                            |
 *   apply                     apply_client
 *     |                            |
 *     v                            v
 *   State ------redact------> ClientState
 *
 * that is, it should not matter if you redact and use apply_client or use
 * apply and then redact---the results should be the same (though see below for
 * a caveat).
 */

import { ProtocolAction, User } from 'protocol/protocol.ts'
import { Result } from 'utils/result.ts'

import { Codec } from 'io-ts/lib/Codec'

export interface Engine<
  Config,
  Intent,
  State,
  Action,
  ClientState,
  Effect,
  UpdateError
> {
  // codecs for all the type parameters
  Config: Codec<Config>;
  Intent: Codec<Intent>;
  State: Codec<State>;
  Action: Codec<Action>;
  ClientState: Codec<ClientState>;
  Effect: Codec<Effect>;
  UpdateError: Codec<UpdateError>;

  // generate the initial engine state
  init: (options: Config) => State;

  // lift a client-generated intent into an action that will be applied
  listen: (
    state: State,
    int: Intent,
    who: User
  ) => Result<Action, UpdateError>;

  // compute the effect of an action on a given state or describe the reason
  // why the update is invalid, inapplicable, or otherwise problematic™
  apply: (
    state: State,
    act: Action | ProtocolAction
  ) => Result<State, UpdateError>;

  // predict the outcome of an intent based on the client state; return null if
  // the outcome is unknown
  predict: (
    state: ClientState,
    int: Intent,
    me: User
  ) => null | Result<Effect, UpdateError>;

  // same as apply, on the client side
  apply_client: (
    state: ClientState,
    eff: Effect | ProtocolAction,
    me: User
  ) => Result<ClientState, UpdateError>;

  // redact a server-side state/action into a client-side state/action for the
  // given recipient
  redact: (state: State, who: User) => ClientState;
  redact_action: (state: State, act: Action, who: User) => Effect;
};