# Werewolf Game

The frontend uses Vue 3, TypeScript, PrimeVue, and the Aura theme.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm run build` to type-check and compile the Vue + TypeScript frontend into `dist/`.
4. Run `npm start` and open `http://localhost:3000`. Starting the server builds the frontend first.
5. Create a room and share its six-character code. Friends open the same address and enter the code to join.

Rooms remain available across page refreshes and disconnects for as long as the server process is running. Room state is in memory, so restarting or redeploying the server clears rooms. Players can choose a six-character alphanumeric room code when creating a room, or leave the field blank to generate one automatically. The lobby supports 4-8 players. The game proceeds through role confirmation, werewolf action, witch action, seer check, and discussion/voting. During night actions, only the acting role marks ready; during role confirmation and voting, all living online players mark ready. A shared five-second countdown then advances the room.

Game actions, vote totals, eliminations, and win conditions are resolved by the server and synchronized to the room. Role information, seer results, and each player's vote are kept private; readiness badges appear in the member list only during voting. Eliminations are announced after all active players have voted and confirmed readiness. If the game continues after an elimination, the next night begins with a hidden random 5-10 second delay before the public five-second countdown.

After a game ends, the room host can restart the game with the same room members. Roles and game progress are reset for the new round.

For players on separate networks, deploy the Node.js server on a host that supports WebSockets and share its public URL.

## Deploy to GitHub Pages

GitHub Pages hosts only static files. The frontend is configured to connect to `wss://werewolf-game-rdj6.onrender.com`. To deploy the Pages frontend:

```sh
npm run deploy
```

To use a different server, set `WEBSOCKET_URL` to its `wss://` URL before building and deploying. The URL is embedded in the generated frontend at build time.

1. Run `npm run deploy`. This builds `dist/` and publishes its contents to the `gh-pages` branch with Jekyll processing disabled.
2. In the repository's **Settings → Pages**, select **Deploy from a branch**, then choose `gh-pages` and `/(root)`.
3. Open the Pages URL shown in repository settings.

The WebSocket server must remain running and allow connections from your Pages site. Room creation and joining will not work if the server is asleep, unavailable, or configured to reject the Pages connection.