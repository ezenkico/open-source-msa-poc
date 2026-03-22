import { connect } from "nats.ws";

export async function connectNats(server: string, token: string){
    // const resp = await fetch("/api/v1/token", {
    //     method: "GET"
    // });

    // const data = await resp.json();
    // const token = data["token"];

    const nc = await connect({
        servers: [server],
        token,
        user: "test"
    });

    return nc;
}
