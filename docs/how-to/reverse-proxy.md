# Run Cuttlely behind a reverse proxy

Use this guide when a reverse proxy or cloud gateway sits in front of a self-hosted install. The proxy must keep streaming requests open. It must also stop reusing an upstream connection before Cuttlely closes that connection.

## 1. Keep upstream connections open

Use HTTP/1.1 between the proxy and Cuttlely. Allow the proxy to reuse upstream connections.

For nginx, start with this example. Change the upstream address and upload limit for your install.

```nginx
upstream cuttlely {
    server 127.0.0.1:43117;
    keepalive 32;
    keepalive_timeout 60s;
}

server {
    client_max_body_size 100m;

    location / {
        proxy_pass http://cuttlely;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location ~ ^/api/v1/(prediction|internal-prediction)(/|$) {
        proxy_pass http://cuttlely;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

Keep the proxy's upstream idle or keep-alive timeout below `HTTP_KEEP_ALIVE_TIMEOUT_MS`. The default server value is 65 seconds. The nginx example uses 60 seconds.

## 2. Keep streams open

Set the proxy read and send timeouts to at least 300 seconds for chat streams. This lets a long answer continue while data is still moving.

Turn buffering off for `/api/v1/prediction`, `/api/v1/internal-prediction`, and every other server-sent event route you expose. Cuttlely already sends `X-Accel-Buffering: no` from prediction, internal prediction, Harness, webhook, Orchestrate, and A2A streaming responses. Keep the explicit proxy rule too, because not every proxy honors that response header.

For a cloud gateway:

1. Use HTTP/1.1 to the upstream server.
2. Enable upstream connection reuse.
3. Set its upstream idle timeout below 65 seconds, unless you raise `HTTP_KEEP_ALIVE_TIMEOUT_MS`.
4. Set its client or stream idle timeout to at least 120 seconds. Cuttlely's current stream heartbeat is every 30 seconds.
5. Disable response buffering for server-sent event routes.
6. Allow request bodies large enough for the uploads your flows accept.

## 3. Set proxy trust

Set `TRUST_PROXY` to the number of trusted proxy hops between the client and Cuttlely. Use `1` when exactly one proxy is in front of the server. Unset or blank trusts no proxy headers. `true` trusts every proxy and is rarely the right choice.

Restart Cuttlely after changing it. Open `/api/v1/ip` through the public address and check that it returns your client address. The setting also controls client-address rate limits and whether a forwarded HTTPS scheme counts for secure cookies.

## 4. Tune the server only when needed

The defaults fit a proxy that stops reusing idle upstream connections after 60 seconds.

| Variable                     | Default                        | Accepted value                                      |
| ---------------------------- | ------------------------------ | --------------------------------------------------- |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | `65000`                        | A whole number from `1000` to `600000` milliseconds |
| `HTTP_HEADERS_TIMEOUT_MS`    | Keep-alive timeout plus `1000` | A whole number above keep-alive, up to `601000`     |

An invalid value writes a warning to the server log and uses the default. Restart Cuttlely after changing either variable.

Cuttlely leaves overall request time limits to the proxy. The Node server's default `requestTimeout` is unchanged.

## 5. Check the result

1. Restart Cuttlely and reload the proxy.
2. Open `/api/v1/ping` through the public address. It should answer `pong`.
3. Start a streaming chat that runs for more than 30 seconds.
4. Leave the app idle for more than one minute, then send another request.
5. Check the proxy and server logs if either request ends without an HTTP response.
