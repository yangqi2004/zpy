/*
 * ZPY game state machine.
 */

import {
  Suit, Rank, TrumpMeta, CardBase, Card, CardPile
} from './cards';
import {
  CardTuple, Tractor, Flight, Hand
} from './trick';
import {
  array_shuffle
} from './utils';

import {strict as assert} from 'assert';

export class ZPY {
  #phase: ZPY.Phase = ZPY.Phase.INIT;
  // rule modifiers
  #rules: ZPY.RuleModifiers;

  // owner of the game
  #owner: ZPY.PlayerID = null;
  // all players; in turn order if #phase > INIT
  #players: ZPY.PlayerID[] = [];
  // rank of each player; always valid
  #ranks: ZPY.PlayerMap<number> = {};
  // number of decks
  #ndecks: number = 0;

  // round counter; > 0 iff #phase > INIT
  #round: number = 0;
  // playing to order index mapping; valid iff #phase > INIT
  #order: ZPY.PlayerMap<number> = {};
  // general-purpose player set for reaching consensus
  #consensus: Set<ZPY.PlayerID> = new Set();

  // contents of the deck; null iff #phase !== DRAW
  #deck: CardBase[] = [];
  // kitty; set before DRAW, replaced by KITTY, consumed by FINISH
  #kitty: CardBase[] = [];
  // list of successful trump bids made during DRAW; last one is the winner
  #bids: {player: ZPY.PlayerID, bid: CardTuple}[] = [];
  // players' hands as they are being drawn
  #draws: ZPY.PlayerMap<CardPile> = {};
  // current index into #players for draws, play, etc.
  #current: number = null;

  // host of the current round; valid iff #phase > INIT
  #host: ZPY.PlayerID | null = null;
  // trump selection for the current round; valid iff #phase > DRAW
  #tr: TrumpMeta = null;
  // hands; valid iff #phase > KITTY
  #hands: ZPY.PlayerMap<Hand> = {};
  // each player's point count; valid if #phase > FRIEND
  #points: ZPY.PlayerMap<number> = {};
  // friends declarations; valid iff #phase > FRIEND
  #friends: {card: Card, nth: number}[] = [];
  // number of times a friend has joined; valid iff #phase > FRIEND
  #joins: number = 0;
  // attacking and host teams; valid if #phase > FRIEND
  #host_team: Set<ZPY.PlayerID> = new Set();
  #atk_team: Set<ZPY.PlayerID> = new Set();

  // leader of the current trick; valid iff #phase >= LEAD
  #leader: ZPY.PlayerID | null = null;
  // lead play for the current trick; valid iff #phase > LEAD
  #lead: Flight | null = null;
  // all plays for the current trick; valid iff #phase > LEAD
  #plays: ZPY.PlayerMap<Flight> = {};
  // current winning player
  #winning: ZPY.PlayerID | null = null;

  constructor(rules: ZPY.RuleModifiers) {
    this.#rules = rules;
  }

  /*
   * Property getters.
   */
  get nplayers(): number { return this.#players.length; }

  /*
   * Phase.INIT : Action.ADD_PLAYER
   *
   * Add a player to the game.  The first player added is the game owner.
   */
  add_player(player: ZPY.PlayerID): ZPY.Result {
    if (this.#players.find(p => p === player)) {
      return new ZPY.DuplicateActionError('already joined game');
    }
    if (this.nplayers === 0) {
      this.#owner = player;
    }
    this.#players.push(player);
    this.#ranks[player] = 2;
  }

  /*
   * Phase.INIT : Action.SET_DECKS
   *
   * Set the number of decks.  Game owner only.
   */
  set_decks(player: ZPY.PlayerID, ndecks: number): ZPY.Result {
    if (player !== this.#owner) {
      return new ZPY.WrongPlayerError('game owner only');
    }
    if (ndecks <= 0) {
      return new ZPY.InvalidArgError('non-positive number of decks');
    }
    this.#ndecks = ndecks;
  }

  /*
   * Shuffle `n` standard decks together.
   */
  private static shuffled_deck(n: number): CardBase[] {
    let deck: CardBase[] = [];

    for (let i = 0; i < n; ++i) {
      for (let suit of [Suit.CLUBS, Suit.DIAMONDS, Suit.SPADES, Suit.HEARTS]) {
        for (let rank = 2; rank <= Rank.A; ++rank) {
          deck.push(new CardBase(suit, rank));
        }
      }
      deck.push(new CardBase(Suit.TRUMP, Rank.S));
      deck.push(new CardBase(Suit.TRUMP, Rank.B));
    }
    assert(deck.length === n * 54);

    return array_shuffle(deck);
  }

  /*
   * Helper for resetting round state; used by multiple phases/actions.
   *
   * This includes: incrementing the round counter, shuffling the deck, setting
   * aside a kitty, and resetting all other per-round internal state.
   */
  private reset_round(starting: ZPY.PlayerID, is_host: boolean): void {
    ++this.#round;
    this.#consensus = new Set();

    this.#deck = ZPY.shuffled_deck(this.#ndecks);

    let kitty_sz = this.#deck.length % this.nplayers;
    if (kitty_sz === 0) kitty_sz = this.nplayers;
    while (kitty_sz > 10) kitty_sz -= this.nplayers;
    while (kitty_sz <= 4) kitty_sz += this.nplayers;

    this.#kitty = [];
    for (let i = 0; i < kitty_sz; ++i) {
      this.#kitty.push(this.#deck.pop());
    }

    this.#bids = [];
    this.#draws = {};
    this.#current = this.#order[starting];

    this.#host = is_host ? starting : null;
    this.#tr = is_host
      ? new TrumpMeta(Suit.TRUMP, this.#ranks[starting])
      : new TrumpMeta(Suit.TRUMP, Rank.B);  // big joker is the sentinel tr
    this.#hands = {};
    this.#points = {};
    this.#friends = [];
    this.#joins = 0;
    this.#host_team.clear();
    this.#atk_team.clear();

    this.#leader = null;
    this.#lead = null;
    this.#plays = {};
    this.#winning = null;

    for (let p of this.#players) {
      this.#draws[p] = new CardPile([], this.#tr);
      this.#points[p] = 0;
    }
  }

  /*
   * Phase.INIT : Action.START_GAME
   *
   * Start the game and transition to Phase.DRAW.  Game owner only.
   */
  start_game(player: ZPY.PlayerID): ZPY.Result {
    if (player !== this.#owner) {
      return new ZPY.WrongPlayerError('game owner only');
    }
    if (this.nplayers < 4) {
      return new ZPY.InvalidPlayError('must have at least 4 players');
    }
    this.#players = array_shuffle(this.#players);
    for (let i = 0; i < this.nplayers; ++i) {
      this.#order[this.#players[i]] = i;
    }
    this.reset_round(this.#owner, false);
    this.#phase = ZPY.Phase.DRAW;
  }

  /*
   * Get the index of the next player in play order.
   */
  private next_player_idx(idx: number): number {
    return ++idx < this.#players.length ? idx : 0;
  }

  /*
   * Phase.DRAW : Action.DRAW_CARD
   *
   * Draw a card for the player in question.  Transition to Phase.PREPARE if
   * the deck empties.
   */
  draw_card(player: ZPY.PlayerID): ZPY.Result {
    if (player !== this.#players[this.#current]) {
      return new ZPY.OutOfTurnError();
    }
    let c = this.#deck.pop();
    this.#draws[player].insert(new Card(c.suit, c.rank, this.#tr));

    if (this.#deck.length === 0) {
      this.#phase = ZPY.Phase.PREPARE;
    }
    this.#current = this.next_player_idx(this.#current);
  }

  /*
   * Phase.DRAW : Action.BID_TRUMP
   * Phase.PREPARE : Action.BID_TRUMP
   *
   * Place a bid for a trump.  This also reindexes each player's current draw
   * pile and changes the current trump selection.
   */
  bid_trump(player: ZPY.PlayerID, bid: CardTuple): ZPY.Result {
    if (bid.arity < 1) {
      return new ZPY.InvalidArgError('bid is empty');
    }

    if (!this.#draws[player].contains([[bid.card, bid.arity]])) {
      return new ZPY.InvalidPlayError('bid not part of hand');;
    }

    if (bid.card.rank <= Rank.A &&
        bid.card.rank !== this.#ranks[this.#host ?? player]) {
      // we bid either the host's rank or our own (in a bid-to-host draw), so
      // valid bids against the appropriate value.
      return new ZPY.InvalidPlayError('invalid trump bid');
    }

    let commit_bid = () => {
      this.#bids.push({player, bid});
      this.#tr = new TrumpMeta(bid.card.suit, bid.card.rank);
      for (let p in this.#draws) this.#draws[p].rehash(this.#tr);
    };

    if (this.#bids.length === 0) {
      // if this is the first bid in a bid-for-host draw, set the host
      this.#host = this.#host ?? player;
      return commit_bid();
    }

    let prev = this.#bids[this.#bids.length - 1];

    if (player === prev.player) {
      if (bid.card.suit === prev.bid.card.suit &&
          bid.arity > prev.bid.arity) {
        return commit_bid();
      }
      return new ZPY.InvalidPlayError('cannot overturn own bid');
    }

    if (bid.arity > prev.bid.arity) return commit_bid();
    if (bid.arity === prev.bid.arity &&
        prev.bid.card.rank <= Rank.A && bid.card.rank >= Rank.S) {
      return commit_bid();
    }
    return new ZPY.InvalidPlayError('bid too low');
  }

  /*
   * Phase.PREPARE : Action.REQUEST_REDEAL
   *
   * Request a redeal.  Only valid if the player has fewer than #ndecks * 5
   * points in hand.
   */
  request_redeal(player: ZPY.PlayerID): ZPY.Result {
    let points = 0;
    for (let [card, n] of this.#draws[player].gen_counts()) {
      points += card.point_value() * n;
    }
    if (points > this.#ndecks * 5) {
      return new ZPY.InvalidPlayError('too many points for redeal');
    }

    this.reset_round(player, false);
    this.#phase = ZPY.Phase.DRAW;
  }

  /*
   * Phase.PREPARE : Action.READY
   *
   * The player has no more bids or redeals to make.  Once everyone is ready,
   * the round can begin, and we transition to Phase.KITTY.
   *
   * Normally, this just entails dumping the kitty into the host's hand.
   * However, if no trump has been set, we have to flip the cards in the kitty
   * in order and use that to determine the trump.
   */
  ready(player: ZPY.PlayerID): ZPY.Result {
    this.#consensus.add(player);
    if (this.#consensus.size !== this.#players.length) return;

    this.#consensus.clear();

    if (this.#bids.length === 0) {
      // if there's no host, the starting player becomes host
      this.#host = this.#host ?? this.#players[this.#current];
      let rank = this.#ranks[this.#host];

      // the natural-trump-only TrumpMeta works for comparisons here
      let ctx_tr = new TrumpMeta(Suit.TRUMP, rank);

      let card = this.#kitty.reduce((highest: Card, c: CardBase) => {
        let card = new Card(c.suit, c.rank, ctx_tr);
        if (!highest) return card;
        return card.rank > highest.rank ? card : highest;
      }, null);

      this.#tr = new TrumpMeta(card.suit, card.rank);
      for (let p in this.#draws) this.#draws[p].rehash(this.#tr);
    }

    for (let c of this.#kitty) {
      this.#draws[this.#host].insert(new Card(c.suit, c.rank, this.#tr));
    }
    this.#phase = ZPY.Phase.KITTY;
  }

  /*
   * Phase.KITTY : Action.REPLACE_KITTY
   *
   * The host discards their kitty.  We Hand-ify every player's draw pile, and
   * transition to Phase.FRIEND.
   */
  replace_kitty(player: ZPY.PlayerID, kitty: CardBase[]): ZPY.Result {
    if (player !== this.#host) {
      return new ZPY.WrongPlayerError('host only');
    }
    if (kitty.length !== this.#kitty.length) {
      return new ZPY.InvalidPlayError('kitty has incorrect size');
    }
    let kitty_pile = new CardPile(kitty, this.#tr);

    if (!this.#draws[player].contains(kitty_pile.gen_counts())) {
      return new ZPY.InvalidPlayError('kitty not part of hand');
    }

    for (let count of kitty_pile.gen_counts()) {
      this.#draws[player].remove(...count);
    }
    this.#kitty = kitty;

    for (let p of this.#players) {
      this.#hands[p] = new Hand(this.#draws[p]);
    }
    this.#draws = {}; // clear this, mostly to prevent bugs
    this.#phase = ZPY.Phase.FRIEND;
  }

  /*
   * Size of the host team given the number of players.
   */
  get nfriends(): number {
    return Math.floor(0.35 * this.nplayers);
  }

  /*
   * Phase.FRIEND : Action.CALL_FRIENDS
   *
   * The host calls their friends, and we transition to Phase.LEAD, where
   * gameplay actually begins.
   */
  call_friends(
    player: ZPY.PlayerID,
    friends: [CardBase, number][]
  ): ZPY.Result {
    // this is the correct number of friends for all single-digit numbers of
    // players and probably at least some double-digit numbers.
    let allowed = this.nfriends;

    if (friends.length !== allowed) {
      return new ZPY.InvalidPlayError(`must call exactly ${allowed} friends`);
    }

    for (let [c, nth] of friends) {
      if (nth < 1 || nth > this.#ndecks) {
        this.#friends.length = 0;
        return new ZPY.InvalidArgError('friend index out of bounds');
      }
      let card = new Card(c.suit, c.rank, this.#tr);

      if (card.v_rank > Rank.A) {
        this.#friends.length = 0;
        return new ZPY.InvalidPlayError('no natural trump friend calls allowed');
      }
      this.#friends.push({card, nth});
    }

    this.#host_team.add(this.#host);

    this.#leader = this.#host;
    this.#current = this.#order[this.#leader];

    this.#phase = ZPY.Phase.LEAD;
  }

  /*
   * Shared initial logic for leading and following.
   *
   * This does data validation and moves #current to the next player, and
   * returns the play as a CardPile on success.
   */
  private init_play(
    player: ZPY.PlayerID,
    play: Flight,
  ): ZPY.Result | CardPile {
    if (player !== this.#players[this.#current]) {
      return new ZPY.OutOfTurnError();
    }
    let play_pile = new CardPile(play.gen_cards(this.#tr), this.#tr);

    if (!this.#hands[player].pile.contains(play_pile.gen_counts())) {
      return new ZPY.InvalidPlayError('play not part of hand');
    }
    this.#current = this.next_player_idx(this.#current);

    return play_pile;
  }

  /*
   * Affirm a play.
   *
   * In addition to recording metadata, this function also performs friend
   * detection.
   */
  private commit_play(
    player: ZPY.PlayerID,
    play: Flight,
    play_pile: CardPile,
  ): void {
    for (let count of play_pile.gen_counts()) {
      this.#hands[player].remove(...count);
    }
    this.#plays[player] = play;

    // set `player` as the new winner if they're the first play or the current
    // winner fails to beat them
    if (!this.#winning || !this.#plays[this.#winning].beats(play)) {
      this.#winning = player;
    }

    for (let tractor of play.tractors) {
      for (let [card, n] of tractor.gen_counts(this.#tr)) {
        for (let friend of this.#friends) {
          if (Card.identical(card, friend.card) &&
              (friend.nth -= n) <= 0) {
            friend.nth = 0;
            this.#host_team.add(player);

            if (++this.#joins === this.nfriends) {
              // add all other players to the attacking team.  note that some
              // of the #joins may be redundant.
              for (let p of this.#players) {
                if (!this.#host_team.has(p)) {
                  this.#atk_team.add(p);
                }
              }
            }
          }
        }
      }
    }
  }

  /*
   * Phase.LEAD : Action.LEAD_PLAY
   *
   * Play a card, a tuple, a tractor, a flight---anything your heart desires!
   * If the leader plays a nontrivial flight, transition to Phase.FLY, else to
   * Phase.FOLLOW.
   */
  lead_play(player: ZPY.PlayerID, play: Flight): ZPY.Result {
    let play_pile = this.init_play(player, play);
    if (!(play_pile instanceof CardPile)) return play_pile;

    this.#lead = play;
    this.#current = this.next_player_idx(this.#order[this.#leader]);

    if (play.tractors.length > 1) {
      this.#consensus.add(player);
      this.#phase = ZPY.Phase.FLY;
      // delay registering the play until Phase.FLY completes
      return;
    }
    this.commit_play(player, play, play_pile);

    this.#phase = ZPY.Phase.FOLLOW;
  }

  /*
   * Phase.FLY : Action.CONTEST_FLY
   *
   * Contest a fly by revealing a play that would beat any component of it.
   * Transitions to Phase.GROUND.
   */
  contest_fly(player: ZPY.PlayerID, reveal: Tractor): ZPY.Result {
    if (player === this.#leader) {
      return new ZPY.WrongPlayerError('cannot contest own flight');
    }
    if (!this.#hands[player].pile.contains(reveal.gen_counts(this.#tr))) {
      return new ZPY.InvalidPlayError('reveal not part of hand');
    }
    for (let component of this.#lead.tractors) {
      if (Tractor.Shape.compare(reveal.shape, component.shape) !== 0 ||
          Tractor.compare(reveal, component) < 0) {
        continue;
      }
      // we beat the flight; force the new flight
      this.#consensus.clear();

      this.#lead = new Flight([component], component.count);

      let play_pile = new CardPile(component.gen_cards(this.#tr), this.#tr);
      this.commit_play(this.#leader, this.#lead, play_pile);

      this.#phase = ZPY.Phase.FOLLOW;
      return;
    }
    return new ZPY.InvalidPlayError('reveal does not contest flight');
  }

  /*
   * Phase.FLY : Action.PASS_CONTEST
   *
   * The equivalent of READY for Phase.FLY.  Once everyone passes, the fly
   * succeeds and play continues to Phase.FOLLOW.
   */
  pass_contest(player: ZPY.PlayerID): ZPY.Result {
    this.#consensus.add(player);
    if (this.#consensus.size !== this.#players.length) return;

    this.#consensus.clear();
    this.#phase = ZPY.Phase.FOLLOW;
  }

  /*
   * Phase.FOLLOW : Action.FOLLOW_PLAY
   *
   * Follow the #lead.  Handles end-of-trick point collection if everyone has
   * played.  Transitions to either Phase.LEAD, or Phase.FINISH if the round
   * has ended.
   */
  follow_lead(player: ZPY.PlayerID, play: Flight): ZPY.Result {
    let play_pile = this.init_play(player, play);
    if (!(play_pile instanceof CardPile)) return play_pile;

    if (play.total !== this.#lead.total) {
      return new ZPY.InvalidPlayError('incorrectly sized play');
    }

    let renege = !this.#hands[player].follow_with(this.#lead, play_pile);
    // TODO: handle renege logic

    this.commit_play(player, play, play_pile);

    if (Object.keys(this.#plays).length === this.#players.length) {
      this.collect_trick();
    }
  }

  /*
   * Collect points at the end of a trick.
   */
  collect_trick(): void {
    for (let player of this.#players) {
      for (let [card, n] of this.#plays[player].gen_counts(this.#tr)) {
        this.#points[this.#winning] += card.point_value() * n;
      }
    }
    if (this.#hands[this.#leader].pile.size === 0) {
      return this.finish_round();
    }
    this.#leader = this.#winning;
    this.#current = this.#order[this.#leader];
    this.#winning = null;
    this.#lead = null;
    this.#plays = {};

    this.#phase = ZPY.Phase.LEAD;
  }

  /*
   * Bump a player's rank.
   *
   * A delta of -1 indicates that the player was J'd.
   */
  rank_up(player: ZPY.PlayerID, delta: number): void {
    // TODO implement me, including point/joker rank barriers
  }

  /*
   * Score and finish up the round.
   *
   * Transitions to Phase.FINISH.
   */
  finish_round(): void {
    let atk_points = this.#players.reduce(
      (total, p) => total + (this.#atk_team.has(p) ? this.#points[p] : 0),
      0
    );
    if (this.#atk_team.has(this.#winning)) {
      // score the kitty to the attacking team
      let kitty_points = this.#kitty.reduce((n, c) => n + c.point_value(), 0);
      let multiplier = Math.max(
        ...this.#plays[this.#winning].tractors.map(t => t.count)
      );
      atk_points += kitty_points * (() => {
        switch (this.#rules.kitty) {
          case ZPY.KittyMultiplierRule.EXP: return 2 ** multiplier;
          case ZPY.KittyMultiplierRule.MULT: return 2 * multiplier;
        }
        assert(false);
      })();
    }

    // number of ranks the attacking team ascends
    let delta = Math.floor(atk_points / (this.#ndecks * 20)) - 2;
    if (atk_points === 0) --delta;

    let winning_team = delta >= 0 ? this.#atk_team : this.#host_team;
    winning_team.forEach(p => this.rank_up(p, Math.abs(delta)));

    // choose the next host
    let next_idx = this.next_player_idx(this.#order[this.#host]);
    while (true) {
      let player = this.#players[next_idx];
      if (this.#host_team.has(player)) {
        this.#host = player;
        break;
      }
      next_idx = this.next_player_idx(next_idx);
    }
  }

  /*
   * Phase.FINISH : Action.START_ROUND
   *
   * Start a new round.
   */
  start_round(player: ZPY.PlayerID): ZPY.Result {
    if (player !== this.#owner) {
      return new ZPY.WrongPlayerError('host only');
    }
    if (this.nplayers < 4) {
      return new ZPY.InvalidPlayError('must have at least 4 players');
    }
    this.reset_round(this.#host, true);
    this.#phase = ZPY.Phase.DRAW;
  }
}

export namespace ZPY {
  export type PlayerID = string;

  export type PlayerMap<T> = { [key: string]: T };

  export enum RenegeRule {
    ACCUSE,   // reneges are tracked, but must be called out by other players
    FORBID,   // disallow plays that would result in a renege
    AUTOLOSE, // reneges immediately cause players to lose
    UNDO_ONE, // allow players to undo their renege play before the trick ends
  }
  export enum RankSkipRule {
    PLAY_ONCE, // must play 5,10,J,K,W once before ranking up
    NO_SKIP,   // must stop at 5,10,J,K,W before passing
    NO_PASS,   // must win on 5,10,J,K,W to pass
    NO_RULE,   // no limits, freely skip any rank
  }
  export enum KittyMultiplierRule {
    EXP,  // 2^n multiplier
    MULT, // 2*n multiplier
  }
  export interface RuleModifiers {
    renege: RenegeRule,
    rank: RankSkipRule,
    kitty: KittyMultiplierRule,
  }

  export enum Phase {
    INIT,    // assembling players
    DRAW,    // drawing cards; bidding on trump
    PREPARE, // last chance to bid or request a redeal
    KITTY,   // host discarding a new kitty
    FRIEND,  // host naming friends
    LEAD,    // player leading a trick
    FLY,     // waiting to see if a lead flies
    FOLLOW,  // players following a lead
    FINISH,  // end-of-round; players can leave
  }

  export enum Action {
    // Phase.INIT
    ADD_PLAYER,
    SET_DECKS,
    START_GAME,
    // Phase.DRAW
    DRAW_CARD,
    BID_TRUMP,
    // Phase.PREPARE
 /* BID_TRUMP, */
    REQUEST_REDEAL,
    READY,
    // Phase.KITTY
    REPLACE_KITTY,
    // Phase.FRIEND
    CALL_FRIENDS,
    // Phase.LEAD
    LEAD_PLAY,
    // Phase.FLY
    CONTEST_FLY,
    PASS_CONTEST,
    // Phase.FOLLOW
    FOLLOW_PLAY,
    // Phase.FINISH
 /* REMOVE_PLAYER, // TODO */
 /* INTRODUCE_PLAYER, // TODO */
    START_ROUND,
  }

  export class Error {
    constructor(readonly msg?: string) {}
    toString(): string { return `${this.constructor.name}: ${this.msg}`; }
  }
  export class InvalidArgError extends Error {
    constructor(msg?: string) { super(msg); }
  }
  export class DuplicateActionError extends Error {
    constructor(msg?: string) { super(msg); }
  }
  export class WrongPlayerError extends Error {
    constructor(msg?: string) { super(msg); }
  }
  export class OutOfTurnError extends Error {
    constructor(msg?: string) { super(msg); }
  }
  export class InvalidPlayError extends Error {
    constructor(msg?: string) { super(msg); }
  }
  export type Result =
      void
    | InvalidArgError
    | DuplicateActionError
    | WrongPlayerError
    | OutOfTurnError
    | InvalidPlayError
    ;
}