# Server transport

The Factory page is a client. One Node process on this machine owns the world and the simulation loop.

Commands are HTTP POST `/command`. The body is a method name and its arguments. The response is that method's result, the full world, and a revision number. A websocket at `/world` pushes the same snapshot after every publish. The world is small, so each message is the whole world. Deltas are a later slice.

The process uses Node's `http` module and the `ws` package. `ws` is the usual websocket server for Node. Hono and Fastify can also serve HTTP and websockets. This process only needs one POST route and one socket, so those frameworks add a layer it does not use. A hand-written websocket parser is the other option, and it is the one that gets framing and upgrades wrong.

The process binds to `127.0.0.1`. A command or a websocket upgrade whose `Origin` header is not the Factory page origin is rejected. There is no auth. A restart loads the seed world. Saving the world to disk is a later slice. `sim.advance` stays on the in-process class for tests and is not a network command.
