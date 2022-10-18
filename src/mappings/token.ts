import { Address, log } from "@graphprotocol/graph-ts";

import { BigDecimal, Bytes, ethereum } from "@graphprotocol/graph-ts";

import { Burn } from "../../generated/templates/BurnableToken/Burnable";
import { Mint } from "../../generated/templates/MintableToken/Mintable";
import {
  Pause,
  Paused,
  Unpause,
  Unpaused,
} from "../../generated/templates/PausableToken/Pausable";
import { Transfer } from "../../generated/templates/StandardToken/ERC20";

import { ERC20 } from "../../generated/TokenRegistry/ERC20";

import {
  BurnEvent,
  MintEvent,
  PauseEvent,
  Token,
  TransferEvent,
} from "../../generated/schema";

import { ONE, toDecimal, ZERO } from "../helpers/number";

import {
  decreaseAccountBalance,
  getOrCreateAccount,
  increaseAccountBalance,
  saveAccountBalanceSnapshot,
} from "./account";
import { StandardToken } from "../../generated/templates";

const GENESIS_ADDRESS = "0x0000000000000000000000000000000000000000";

export function getOrCreateToken(tokenAddress: Bytes): Token | null {
  let tokenId = tokenAddress.toHex();
  let existingToken = Token.load(tokenId);

  if (existingToken != null) {
    return existingToken as Token;
  }

  let newToken = new Token(tokenId);
  newToken.address = tokenAddress;

  let tokenContract = ERC20.bind(Address.fromString(tokenId));

  let erc20NameCall = tokenContract.try_name();
  if (erc20NameCall.reverted) {
    log.warning("Calling name() reverted for token {}", [tokenId]);
    return null;
  } else {
    newToken.name = erc20NameCall.value;
  }

  let erc20SymbolCall = tokenContract.try_symbol();
  if (erc20SymbolCall.reverted) {
    log.warning("Calling symbol() reverted for token {}", [tokenId]);
    return null;
  } else {
    newToken.symbol = erc20SymbolCall.value;
  }

  let erc20DecimalsCall = tokenContract.try_decimals();
  if (erc20DecimalsCall.reverted) {
    log.warning("Calling decimals() reverted for token {}", [tokenId]);
    return null;
  } else {
    newToken.decimals = erc20DecimalsCall.value;
  }

  newToken.description = null;
  newToken.imageUrl = null;
  newToken.flags = ["detailed"];

  newToken.eventCount = ZERO;
  newToken.burnEventCount = ZERO;
  newToken.mintEventCount = ZERO;
  newToken.transferEventCount = ZERO;

  let initialSupply = tokenContract.try_totalSupply();

  newToken.totalSupply = initialSupply.reverted
    ? ZERO.toBigDecimal()
    : toDecimal(initialSupply.value, newToken.decimals);
  newToken.totalBurned = ZERO.toBigDecimal();
  newToken.totalMinted = ZERO.toBigDecimal();
  newToken.totalTransferred = ZERO.toBigDecimal();

  log.debug(
    "Adding token to registry, name: {}, symbol: {}, address: {}, decimals: {}, flags: {}",
    [
      newToken.name,
      newToken.symbol,
      newToken.id,
      newToken.decimals.toString(), // TODO: use token.decimals.toString() when type 'i32' implements toString()
      newToken.flags.length ? newToken.flags.join("|") : "none",
    ]
  );

  newToken.save();

  // Start indexing token events
  StandardToken.create(Address.fromString(tokenId));

  return newToken;
}

export function handleTransfer(event: Transfer): void {
  let token = getOrCreateToken(event.address);

  if (token != null) {
    let amount = toDecimal(event.params.value, token.decimals);

    let isBurn =
      token.flags.includes("burnable-transfer") &&
      event.params.to.toHex() == GENESIS_ADDRESS;
    let isMint =
      token.flags.includes("mintable-transfer") &&
      event.params.from.toHex() == GENESIS_ADDRESS;
    let isTransfer = !isBurn && !isMint;

    // Update token event logs
    let eventEntityId: string;

    if (isBurn) {
      let eventEntity = handleBurnEvent(
        token,
        amount,
        event.params.from,
        event
      );

      eventEntityId = eventEntity.id;
    } else if (isMint) {
      let eventEntity = handleMintEvent(token, amount, event.params.to, event);

      eventEntityId = eventEntity.id;
    } else if (isTransfer) {
      let eventEntity = handleTransferEvent(
        token,
        amount,
        event.params.from,
        event.params.to,
        event
      );

      eventEntityId = eventEntity.id;
    }

    // Updates balances of accounts
    if (isTransfer || isBurn) {
      let sourceAccount = getOrCreateAccount(event.params.from);

      let accountBalance = decreaseAccountBalance(
        sourceAccount,
        token as Token,
        amount
      );
      accountBalance.block = event.block.number;
      accountBalance.modified = event.block.timestamp;
      accountBalance.transaction = event.transaction.hash;

      sourceAccount.save();
      accountBalance.save();

      // To provide information about evolution of account balances
      saveAccountBalanceSnapshot(accountBalance, eventEntityId, event);
    }

    if (isTransfer || isMint) {
      let destinationAccount = getOrCreateAccount(event.params.to);

      let accountBalance = increaseAccountBalance(
        destinationAccount,
        token as Token,
        amount
      );
      accountBalance.block = event.block.number;
      accountBalance.modified = event.block.timestamp;
      accountBalance.transaction = event.transaction.hash;

      destinationAccount.save();
      accountBalance.save();

      // To provide information about evolution of account balances
      saveAccountBalanceSnapshot(accountBalance, eventEntityId, event);
    }
  }
}

export function handleBurn(event: Burn): void {
  let token = getOrCreateToken(event.address);

  if (token != null) {
    let amount = toDecimal(event.params.value, token.decimals);

    // Persist burn event log
    let eventEntity = handleBurnEvent(
      token,
      amount,
      event.params.burner,
      event
    );

    // Update source account balance
    let account = getOrCreateAccount(event.params.burner);

    let accountBalance = decreaseAccountBalance(
      account,
      token as Token,
      amount
    );
    accountBalance.block = event.block.number;
    accountBalance.modified = event.block.timestamp;
    accountBalance.transaction = event.transaction.hash;

    account.save();
    accountBalance.save();

    // To provide information about evolution of account balances
    saveAccountBalanceSnapshot(accountBalance, eventEntity.id, event);
  }
}

export function handleMint(event: Mint): void {
  let token = getOrCreateToken(event.address);

  if (token != null) {
    let amount = toDecimal(event.params.amount, token.decimals);

    // Persist mint event log
    let eventEntity = handleMintEvent(token, amount, event.params.to, event);

    // Update destination account balance
    let account = getOrCreateAccount(event.params.to);

    let accountBalance = increaseAccountBalance(
      account,
      token as Token,
      amount
    );
    accountBalance.block = event.block.number;
    accountBalance.modified = event.block.timestamp;
    accountBalance.transaction = event.transaction.hash;

    account.save();
    accountBalance.save();

    // To provide information about evolution of account balances
    saveAccountBalanceSnapshot(accountBalance, eventEntity.id, event);
  }
}

export function handlePause(event: Pause): void {
  let token = getOrCreateToken(event.address);

  handlePauseEvent(token, true, event);
}

export function handlePaused(event: Paused): void {
  let token = getOrCreateToken(event.address);

  handlePauseEvent(token, true, event);
}

export function handleUnpause(event: Unpause): void {
  let token = getOrCreateToken(event.address);

  handlePauseEvent(token, false, event);
}

export function handleUnpaused(event: Unpaused): void {
  let token = getOrCreateToken(event.address);

  handlePauseEvent(token, false, event);
}

function handleBurnEvent(
  token: Token | null,
  amount: BigDecimal,
  burner: Bytes,
  event: ethereum.Event
): BurnEvent {
  let burnEvent = new BurnEvent(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  );
  burnEvent.token = event.address.toHex();
  burnEvent.amount = amount;
  burnEvent.sender = event.transaction.from;
  burnEvent.burner = burner;

  burnEvent.block = event.block.number;
  burnEvent.timestamp = event.block.timestamp;
  burnEvent.transaction = event.transaction.hash;

  burnEvent.save();

  // Track total supply/burned
  if (token != null) {
    token.eventCount = token.eventCount.plus(ONE);
    token.burnEventCount = token.burnEventCount.plus(ONE);
    token.totalSupply = token.totalSupply.minus(amount);
    token.totalBurned = token.totalBurned.plus(amount);
    token.save();
  }

  return burnEvent;
}

function handleMintEvent(
  token: Token | null,
  amount: BigDecimal,
  destination: Bytes,
  event: ethereum.Event
): MintEvent {
  let mintEvent = new MintEvent(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  );
  mintEvent.token = event.address.toHex();
  mintEvent.amount = amount;
  mintEvent.sender = event.transaction.from;
  mintEvent.destination = destination;
  mintEvent.minter = event.transaction.from;

  mintEvent.block = event.block.number;
  mintEvent.timestamp = event.block.timestamp;
  mintEvent.transaction = event.transaction.hash;

  mintEvent.save();

  // Track total token supply/minted
  if (token != null) {
    token.eventCount = token.eventCount.plus(ONE);
    token.mintEventCount = token.mintEventCount.plus(ONE);
    token.totalSupply = token.totalSupply.plus(amount);
    token.totalMinted = token.totalMinted.plus(amount);

    token.save();
  }

  return mintEvent;
}

function handleTransferEvent(
  token: Token | null,
  amount: BigDecimal,
  source: Bytes,
  destination: Bytes,
  event: ethereum.Event
): TransferEvent {
  let transferEvent = new TransferEvent(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  );
  transferEvent.token = event.address.toHex();
  transferEvent.amount = amount;
  transferEvent.sender = source;
  transferEvent.source = source;
  transferEvent.destination = destination;

  transferEvent.block = event.block.number;
  transferEvent.timestamp = event.block.timestamp;
  transferEvent.transaction = event.transaction.hash;

  transferEvent.save();

  // Track total token transferred
  if (token != null) {
    token.eventCount = token.eventCount.plus(ONE);
    token.transferEventCount = token.transferEventCount.plus(ONE);
    token.totalTransferred = token.totalTransferred.plus(amount);

    token.save();
  }

  return transferEvent;
}

function handlePauseEvent(
  token: Token | null,
  paused: boolean,
  event: ethereum.Event
): PauseEvent {
  let pauseEvent = new PauseEvent(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  );
  pauseEvent.token = event.address.toHex();
  pauseEvent.amount = paused ? ONE.toBigDecimal() : ZERO.toBigDecimal();
  pauseEvent.sender = event.transaction.from;
  pauseEvent.pauser = event.transaction.from;

  pauseEvent.block = event.block.number;
  pauseEvent.timestamp = event.block.timestamp;
  pauseEvent.transaction = event.transaction.hash;

  pauseEvent.save();

  if (token != null) {
    token.paused = paused;

    token.save();
  }

  return pauseEvent;
}
