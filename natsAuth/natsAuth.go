package natsauth

import (
	"log"
	"os"
	"time"

	jwt "github.com/nats-io/jwt/v2"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"
)

type ConnectionData struct {
	seed []byte
	url  string
}

func GetConnectionDataEnv() ConnectionData {
	return ConnectionData{
		seed: []byte(env("ACCOUNT_SIGNER_SEED", "SAANRZECQN62J4HG4RBV233VTX6DJ4ZKFDDOAOFGFO52GFXZ4IZ7W5IZFE")),
		url:  env("NATS_URL", "nats://auth:auth@localhost:4222"),
	}
}

type ResponseData struct {
	Account string          `json:"account"`
	Pub     *jwt.Permission `json:"pub,omitempty"`
	Sub     *jwt.Permission `json:"sub,omitempty"`
}

type ListenerHandler func(token *string) (*ResponseData, error)

func badError(m *nats.Msg, nc *nats.Conn, accountKP nkeys.KeyPair, resp *jwt.AuthorizationResponseClaims, err error) {
	resp.Error = err.Error()
	respJWT, err := resp.Encode(accountKP)
	if err != nil {
		_ = nc.Publish(m.Reply, []byte(`{"error":"Bad jwt response"}`))
		return
	}
	_ = nc.Publish(m.Reply, []byte(respJWT))
}

func Listen(handler ListenerHandler, cData ConnectionData) {
	url, seed := cData.url, cData.seed

	accountKP, err := nkeys.FromSeed(seed)
	if err != nil {
		log.Fatal(err)
	}

	accountPK, err := accountKP.PublicKey()
	if err != nil {
		log.Fatal(err)
	}

	nc, err := nats.Connect(url,
		nats.Name("auth-validator"),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(500*time.Millisecond),
	)
	must(err)
	defer nc.Drain()

	// Queue group => exactly one instance handles each request
	_, err = nc.QueueSubscribe("$SYS.REQ.USER.AUTH", "auth-workers", func(m *nats.Msg) {
		log.Printf("data: %q\n", m.Data)

		ar, err := jwt.DecodeAuthorizationRequestClaims(string(m.Data))
		if err != nil {
			log.Printf("bad auth request JWT: %v", err)
			// You can still reply with an error or just return
			_ = nc.Publish(m.Reply, []byte(`{"error":"bad_request"}`))
			return
		}

		req := ar.AuthorizationRequest

		// Prefer explicit nats.user_nkey; fall back to connect_opts.nkey
		userNKey := req.UserNkey
		connect := req.ConnectOptions
		client := req.ClientInformation
		if userNKey == "" {
			userNKey = connect.Nkey
		}

		log.Printf("Token: %s\tJWT: %s\n", connect.Token, connect.JWT)

		// Print the request for inspection
		log.Printf("AUTH REQ ok: ip=%s user=%q nkey=%s\n",
			client.Host, client.User, userNKey)

		log.Printf("Audience: %s\n", ar.Server.ID)

		resp := jwt.NewAuthorizationResponseClaims(userNKey)

		respData, err := handler(&connect.Token)

		if err != nil {
			log.Printf("Failed reponse: %e\n", err)
			badError(m, nc, accountKP, resp, err)
			return
		}

		uc := jwt.NewUserClaims(userNKey)
		uc.Name = client.Name
		uc.Audience = respData.Account

		pub := respData.Pub
		sub := respData.Sub

		if pub != nil {
			uc.Permissions.Pub = *respData.Pub
		}
		if sub != nil {
			uc.Permissions.Sub = *respData.Sub
		}

		userJWT, err := uc.Encode(accountKP)
		if err != nil {
			log.Printf("Failed user: %e\n", err)
			badError(m, nc, accountKP, resp, err)
			return
		}

		// aud = server id this response is for (recommended)
		resp.IssuerAccount = accountPK
		resp.Audience = ar.Server.ID
		resp.Jwt = userJWT

		respJWT, err := resp.Encode(accountKP)
		if err != nil {
			log.Printf("encode auth response: %v\n", err)
			_ = nc.Publish(m.Reply, []byte(`{"error":"encode_auth_response"}`))
			return
		}

		// 4) Send back the *JWT string* as reply
		if err := nc.Publish(m.Reply, []byte(respJWT)); err != nil {
			log.Printf("publish reply: %v\n", err)
		}
		log.Printf("Sent Data: %s", respJWT)
	})
	must(err)

	log.Println("auth-validator listening on $SYS.REQ.USER.AUTH (queue: auth-workers)")
	select {}
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
