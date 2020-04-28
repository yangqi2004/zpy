/*
 * toplevel ZPY game component
 *
 * handles initial configuration, player join/part, and the client protocol,
 * then delegates the rest to Board
 */
import * as React from 'react'

import * as P from 'protocol/protocol.ts'
import { GameId } from 'server/server.ts'
import { GameClient } from 'protocol/client.ts'

import { ZPY } from 'lib/zpy/zpy.ts'
import * as ZPYEngine from 'lib/zpy/engine.ts'

import { Client, EngineCallbacks } from 'components/zpy/common.ts'
import { Board } from 'components/zpy/Board.tsx'

import { strict as assert} from 'assert'


export class Game extends React.Component<Game.Props, Game.State> {
  constructor(props: Game.Props) {
    super(props);

    this.onClose = this.onClose.bind(this);
    this.onReset = this.onReset.bind(this);

    this.attempt = this.attempt.bind(this);
    this.subscribeReset = this.subscribeReset.bind(this);

    this.state = {
      client: null,
      subscriptions: [],
    };
  }

  componentDidMount() {
    this.ensureClient();
  }
  componentDidUpdate() {
    this.ensureClient();
  }

  ensureClient(): Client {
    if (this.state.client !== null) return this.state.client;

    const client: Client = new GameClient(
      ZPYEngine,
      this.props.path,
      this.props.id,
      this.props.nick,
    );
    client.onClose = this.onClose;
    client.onReset = this.onReset;
    client.onUpdate = this.onUpdate.bind(this, null);

    this.setState({client});
    return client;
  }

  onClose(client: Client) {
    this.setState({client: null});
  }

  onReset(client: Client) {
    if (client.state.phase === ZPY.Phase.INIT &&
        !client.state.players.includes(client.me.id)) {
      const err = client.attempt({
        kind: 'add_player',
        args: [client.me.id],
      });
    }
    this.setState({client});

    for (let callback of this.state.subscriptions) {
      callback(client.state);
    }
  }

  onUpdate<T>(
    cb: null | ((effect: ZPYEngine.Effect, ctx?: T) => void),
    client: Client,
    command: P.Command<ZPYEngine.Effect>,
    ctx?: T,
  ) {
    if (command.kind === 'engine') {
      cb?.(command.effect, ctx);
    }
    this.setState({client});
  }

  onReject<T>(
    cb: null | ((ue: ZPYEngine.UpdateError, ctx?: T) => void),
    client: Client,
    ue: ZPYEngine.UpdateError,
    ctx?: T,
  ) {
    cb?.(ue, ctx);
    this.setState({client});
  }

  attempt(
    intent: ZPYEngine.Intent,
    onUpdate: (effect: ZPYEngine.Effect, ctx?: any) => void,
    onReject: (ue: ZPYEngine.UpdateError, ctx?: any) => void,
    ctx?: any,
  ) {
    this.state.client.attempt(
      intent,
      this.onUpdate.bind(this, onUpdate),
      this.onReject.bind(this, onReject),
      ctx
    );
  }

  subscribeReset(callback: (state: ZPYEngine.ClientState) => void) {
    this.setState((state, props) => ({
      subscriptions: [...state.subscriptions, callback]
    }));
  }

  render() {
    const client = this.state.client;

    if (client === null) {
      return <div className="done">
        the game has ended
      </div>;
    }
    if (client.state === null) return null;

    return <Board
      me={client.me}
      zpy={client.state}
      users={client.users}
      funcs={{
        attempt: this.attempt,
        subscribeReset: this.subscribeReset,
      }}
    />;
  }
}

export namespace Game {

export type Props = {
  id: GameId;
  nick: string;
  path: string;
};

export type State = {
  client: null | Client;
  subscriptions: ((state: ZPYEngine.ClientState) => void)[];
};

}
