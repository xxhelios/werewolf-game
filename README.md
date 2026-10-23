# Werewolf Game

The frontend uses Vue 3, TypeScript, PrimeVue, and the Aura theme.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm run build` to type-check and compile the Vue + TypeScript frontend into `dist/`.
4. Run `npm start` and open `http://localhost:3000`. Starting the server builds the frontend first.
5. Create a room and share its six-character code. Friends open the same address and enter the code to join.

Rooms remain available across page refreshes and disconnects for as long as the server process is running. The browser remembers each player's ID and automatically reconnects using that ID to restore the existing room and game; room state is in memory, so restarting or redeploying the server clears rooms. Players can choose a six-character alphanumeric room code when creating a room, or leave the field blank to generate one automatically. The lobby supports 4-8 players. Players can leave from the button beside the room code; if the host leaves, another member becomes host. Leaving during a game removes that player from the current game, while a temporary disconnect preserves their seat and role. The game proceeds through role confirmation, werewolf action, witch action, seer check, dawn/death speeches, discussion/voting, and public vote results. Games with 7-8 players include one Hunter, replacing a Villager; 4-6 player role setups are unchanged. If the Hunter is voted out, they can shoot and eliminate one living player or decline to shoot; the Hunter remains eliminated either way. The final win condition is checked after the Hunter's choice. During night actions, only the acting role marks ready; during role confirmation and voting, living online players mark ready, and all online room members confirm vote results. Role confirmation and vote-result confirmations cannot be withdrawn after submission. Newly eliminated players each click “入土为安” after speaking; after all of them confirm, a shared five-second countdown advances to discussion/voting. If nobody was eliminated overnight, the game proceeds directly to discussion/voting.

Game actions, vote totals, eliminations, and win conditions are resolved by the server and synchronized to the room. The game board shows the current role counts (for example, the number of Werewolves and Villagers), without revealing which player has each role. During voting, players may select a target or confirm without selecting one to abstain. Role information, seer results, and each player's vote are kept private; vote totals are revealed in the public result phase after voting ends. Readiness badges appear during role confirmation, death speeches, voting, and vote-result confirmation. Night eliminations are announced at dawn and shown in the member list during the death-speech step. When every online player confirms the vote results, the game ends or enters the next night; if the game continues after an elimination, that night begins with a hidden random 5-10 second delay.

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