"use client"

import { connectNats } from "@/util/natsListener";
import { NatsConnection } from "nats.ws";
import { FC, useEffect, useState } from "react";

export interface BasePageProps{
    server: string
}

const BasePage: FC<BasePageProps> = (props) => {
    const [nc, setNC] = useState<NatsConnection | null>(null);

    useEffect(() => {
        connectNats(props.server, "test")
            .then(nat => setNC(nat));
    }, []);

    return <div>
        test
    </div>
}

export default BasePage;

