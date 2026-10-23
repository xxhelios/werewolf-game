# Werewolf Game

The frontend uses Vue 3, TypeScript, PrimeVue, and the Aura theme.

## Run locally

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm run build` to type-check and compile the Vue + TypeScript frontend into `dist/`.
4. Run `npm start` and open `http://localhost:3000`. Starting the server builds the frontend first.
5. Create a room and share its four-character alphanumeric code. Friends open the same address and enter the code to join.

Rooms remain available across page refreshes and disconnects for as long as the server process is running. The browser remembers each player's ID and room code and automatically reconnects using both to restore the existing room and game; room state is in memory, so restarting or redeploying the server clears rooms. Players can choose a four-character alphanumeric room code when creating a room, or leave the field blank to generate one automatically. The lobby supports 4-12 players. Players can leave from the button beside the room code; if the host leaves, another member becomes host. Leaving during a game removes that player from the current game, while a temporary disconnect preserves their seat and role. Visitors can use the “观战” button with a room code to watch without occupying a player seat; spectators can see all assigned roles and live game progress but cannot take actions or vote. The game proceeds through role confirmation, werewolf action, witch action, seer check, dawn/death speeches, discussion/voting, and public vote results. Six-player games have two Werewolves, one Seer, one Witch, and two Villagers. Seven-player games have two Werewolves, one Hunter, one Seer, one Witch, and two Villagers. Eight-player games have three Werewolves, one Hunter, one Seer, one Witch, and two Villagers. Nine-player games have three Werewolves, one Hunter, one Seer, one Witch, and three Villagers. Ten-player games add one Lover-Brain (恋爱脑) to the nine-player setup; eleven-player games add one Villager to the ten-player setup; twelve-player games use four Werewolves, one Hunter, one Seer, one Witch, one Lover-Brain, and four Villagers. Four- and five-player setups are unchanged. The Lover-Brain automatically uses their immunity token if voted out: they survive, but permanently lose their speaking and voting rights. If the Hunter is voted out, they can shoot and eliminate one living player or decline to shoot; the Hunter remains eliminated either way. The final win condition is checked after the Hunter's choice. During night actions, only the acting role marks ready; during role confirmation and voting, eligible living online players mark ready, and all online room members confirm vote results. Role confirmation and vote-result confirmations cannot be withdrawn after submission. Newly eliminated players each click “入土为安” after speaking; after all of them confirm, a shared five-second countdown advances to discussion/voting. If nobody was eliminated overnight, the game proceeds directly to discussion/voting.

Game actions, vote totals, eliminations, and win conditions are resolved by the server and synchronized to the room. The game board shows the current role counts (for example, the number of Werewolves and Villagers), without revealing which player has each role. Werewolf players can see their fellow Werewolves' identities in the room member list and their target intentions beside the eligible targets; wolves can only confirm once all online wolves agree on the same target. Wolves can target any living player, including a fellow Werewolf or themselves. Other players only see their own role, and spectators see all roles. During voting, players may select a target or confirm without selecting one to abstain. If multiple players tie for the highest vote count, an additional runoff vote is held among only those tied players; if the runoff is also tied or has no votes, nobody is eliminated by the vote. Individual votes remain private while voting is in progress; after voting, the public results show each candidate's vote total and the names of players who voted for them. The Lover-Brain's spent immunity and loss of speaking/voting rights are shown publicly; the server excludes them from future vote actions and speaking submissions. Readiness badges appear during role confirmation, death speeches, voting, and vote-result confirmation. Night eliminations are announced at dawn and shown in the member list during the death-speech step. When every online player confirms the vote results, the game ends or enters the next night; if the game continues after an elimination, that night begins with a hidden random 5-10 second delay.

After a game ends, the room host can restart the game with the same room members. Roles and game progress are reset for the new round.

New players are given a random fruit-and-animal nickname by default. They can edit it before creating or joining a room, or change their name in the lobby.

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