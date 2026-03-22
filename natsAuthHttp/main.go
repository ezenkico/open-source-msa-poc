package main

import (
	"errors"
	"io"
	"log"
	"net/http"
	"os"

	"encoding/json"
	natsauth "github.com/ezenkico/open-source-msa-poc/natsAuth"
)

func main() {
	server := env("AUTH_SERVER", "http://localhost:8000/api/v2/nats-auth")
	natsauth.Listen(func(token *string) (*natsauth.ResponseData, error) {
		log.Printf("(main)Token: %s", *token)

		req, err := http.NewRequest(http.MethodGet, server, nil)
		if err != nil {
			return nil, err
		}

		bearer := "Bearer " + *token

		req.Header.Add("Authorization", bearer)

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode > 300 {
			return nil, errors.New("invalid token")
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)

		if err != nil {
			return nil, err
		}

		var res natsauth.ResponseData

		err = json.Unmarshal(body, &res)
		if err != nil {
			return nil, err
		}

		return &res, nil
	}, natsauth.GetConnectionDataEnv())
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
