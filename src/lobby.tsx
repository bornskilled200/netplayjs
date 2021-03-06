import {
  NetplayState,
  NetplayInput,
  NetplayPlayer,
  NetplayManager
} from "./netplay";

import { PongInput } from "./pong";

import { assert } from "chai";

import * as query from "query-string";
import * as QRCode from "qrcode";

import Peer from "peerjs";
import EWMASD from "./ewmasd";

export interface GameType<TState, TInput> {
  // Given a list of players, return the initial game state and initial inputs.
  getInitialStateAndInputs(
    players: Array<NetplayPlayer>
  ): [TState, Map<NetplayPlayer, TInput>];

  // The game simulation timestep, in milliseconds.
  timestep: number;

  // The dimensions of the rendering canvas.
  canvasWidth: number;
  canvasHeight: number;

  getInputFromJSON(json: any): TInput;
  getStateFromJSON(json: any): TState;

  draw(state: TState, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D);

  getInputReader(
    document: HTMLDocument,
    canvas: HTMLCanvasElement
  ): () => TInput;
}

export function start<
  TInput extends NetplayInput<TInput>,
  TState extends NetplayState<TState, TInput>,
  TGameType extends GameType<TState, TInput>
>(gameType: TGameType) {
  const pingMeasure = new EWMASD(0.2);

  const peer = new Peer();

  const parsedHash = query.parse(window.location.hash);
  const isClient = !!parsedHash.room;

  const canvas = document.createElement("canvas");
  canvas.width = gameType.canvasWidth;
  canvas.height = gameType.canvasHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  const stats = document.createElement("div");
  document.body.appendChild(stats);

  let netplayManager: NetplayManager<TState, TInput> | null = null;
  let players: Array<NetplayPlayer> | null = null;

  const PING_INTERVAL = 100;

  if (!isClient) {
    console.log("This is a server.");
    peer.on("error", err => console.error(err));

    peer.on("open", id => {
      let joinURL = `${window.location.href}#room=${id}`;
      stats.innerHTML = `<div>Join URL (Open in a new window or send to a friend): <a href="${joinURL}">${joinURL}<div>`;

      const qrCanvas = document.createElement("canvas");
      stats.appendChild(qrCanvas);
      QRCode.toCanvas(qrCanvas, joinURL);
    });

    peer.on("connection", conn => {
      players = [
        {
          getID() {
            return 0;
          },
          isLocalPlayer() {
            return true;
          },
          isRemotePlayer() {
            return false;
          },
          isServer() {
            return true;
          },
          isClient() {
            return false;
          }
        },
        {
          getID() {
            return 1;
          },
          isLocalPlayer() {
            return false;
          },
          isRemotePlayer() {
            return true;
          },
          isServer() {
            return false;
          },
          isClient() {
            return true;
          }
        }
      ];

      let [initialState, initialInputs] = gameType.getInitialStateAndInputs(
        players
      );

      netplayManager = new NetplayManager(
        true,
        initialState,
        initialInputs,
        10,
        pingMeasure,
        gameType.timestep,
        (frame, input) => {
          conn.send({ type: "input", frame: frame, input: input.toJSON() });
        },
        (frame, state) => {
          conn.send({ type: "state", frame: frame, state: state.toJSON() });
        }
      );

      conn.on("error", err => console.error(err));
      conn.on("data", data => {
        if (data.type === "input") {
          netplayManager!.onRemoteInput(
            data.frame,
            players![1],
            gameType.getInputFromJSON(data.input)
          );
        } else if (data.type == "ping-req") {
          conn.send({ type: "ping-resp", sent_time: data.sent_time });
        } else if (data.type == "ping-resp") {
          pingMeasure.update(Date.now() - data.sent_time);
        }
      });
      conn.on("open", () => {
        console.log("Client has connected... Starting game...");

        setInterval(() => {
          conn.send({ type: "ping-req", sent_time: Date.now() });
        }, PING_INTERVAL);

        requestAnimationFrame(gameLoop);
      });
    });
  } else {
    console.log("This is a client.");

    peer.on("error", err => console.error(err));
    peer.on("open", () => {
      console.log(`Connecting to room ${parsedHash.room}.`);
      const conn = peer.connect(parsedHash.room as string, {
        serialization: "json",
        reliable: true
      });

      players = [
        {
          getID() {
            return 0;
          },
          isLocalPlayer() {
            return false;
          },
          isRemotePlayer() {
            return true;
          },
          isServer() {
            return true;
          },
          isClient() {
            return false;
          }
        },
        {
          getID() {
            return 1;
          },
          isLocalPlayer() {
            return true;
          },
          isRemotePlayer() {
            return false;
          },
          isServer() {
            return false;
          },
          isClient() {
            return true;
          }
        }
      ];

      let [initialState, initialInputs] = gameType.getInitialStateAndInputs(
        players
      );

      netplayManager = new NetplayManager(
        false,
        initialState,
        initialInputs,
        10,
        pingMeasure,
        gameType.timestep,
        (frame, input) => {
          conn.send({ type: "input", frame: frame, input: input.toJSON() });
        }
      );

      conn.on("error", err => console.error(err));
      conn.on("data", data => {
        if (data.type === "input") {
          netplayManager!.onRemoteInput(
            data.frame,
            players![0],
            gameType.getInputFromJSON(data.input)
          );
        } else if (data.type === "state") {
          netplayManager!.onStateSync(
            data.frame,
            gameType.getStateFromJSON(data.state)
          );
        } else if (data.type == "ping-req") {
          conn.send({ type: "ping-resp", sent_time: data.sent_time });
        } else if (data.type == "ping-resp") {
          pingMeasure.update(Date.now() - data.sent_time);
        }
      });
      conn.on("open", () => {
        console.log("Successfully connected to server... Starting game...");

        setInterval(() => {
          conn.send({ type: "ping-req", sent_time: Date.now() });
        }, PING_INTERVAL);
        requestAnimationFrame(gameLoop);
      });
    });
  }

  const TIMESTEP = gameType.timestep;

  let inputReader = gameType.getInputReader(document, canvas);

  let lastFrameTime = 0;
  function gameLoop(timestamp) {
    if (timestamp - lastFrameTime >= Math.floor(TIMESTEP)) {
      // Tick state forward.
      let input = inputReader();
      netplayManager!.tick(input);

      // Draw state to canvas.
      gameType.draw(netplayManager!.getState(), canvas, ctx);

      // Update stats
      stats.innerHTML = `
      <div>Timestep: ${timestamp - lastFrameTime}</div>
      <div>Ping: ${pingMeasure
        .average()
        .toFixed(2)} ms +/- ${pingMeasure.stddev().toFixed(2)} ms</div>
      <div>History Size: ${netplayManager!.history.length}</div>
      <div>Frame Number: ${netplayManager!.currentFrame()}</div>
      <div>Largest Future Size: ${netplayManager!.largestFutureSize()}</div>
      <div>Predicted Frames: ${netplayManager!.predictedFrames()}</div>
      <div title="If true, then the other player is running slow, so we wait for them.">Stalling: ${netplayManager!.shouldStall()}</div>
      `;

      lastFrameTime = timestamp;
    }

    requestAnimationFrame(gameLoop);
  }
}
