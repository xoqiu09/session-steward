package main

import "testing"

func TestServeURL(t *testing.T) {
	hosts := []string{"mac.example.ts.net"}
	cases := []struct {
		name, status string
		want         remoteURL
		ok           bool
	}{
		{"443 上的面板", `{"Web":{"mac.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}}}`,
			remoteURL{URL: "https://mac.example.ts.net", Found: true}, true},
		{"443 被别的服务占用，面板在 8443", `{"Web":{"mac.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:18084"}}},
			"mac.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}},"AllowFunnel":{"mac.example.ts.net:443":true}}`,
			remoteURL{URL: "https://mac.example.ts.net:8443", Found: true}, true},
		{"localhost 写法", `{"Web":{"mac.example.ts.net:10000":{"Handlers":{"/":{"Proxy":"localhost:7788"}}}}}`,
			remoteURL{URL: "https://mac.example.ts.net:10000", Found: true}, true},
		{"开了 Funnel 的面板", `{"Web":{"mac.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}},"AllowFunnel":{"mac.example.ts.net:443":true}}`,
			remoteURL{URL: "https://mac.example.ts.net", Funnel: true, Found: true}, true},
		{"优先不开 Funnel 的", `{"Web":{"mac.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}},
			"mac.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}},"AllowFunnel":{"mac.example.ts.net:443":true}}`,
			remoteURL{URL: "https://mac.example.ts.net:8443", Found: true}, true},
		{"主机名不在 remote_hosts", `{"Web":{"other.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}}}`, remoteURL{}, false},
		{"转发到别的机器", `{"Web":{"mac.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://10.0.0.2:7788"}}}}}`, remoteURL{}, false},
		{"没有 serve", `{}`, remoteURL{}, false},
		{"不是 JSON", `No serve config`, remoteURL{}, false},
	}
	for _, c := range cases {
		got, ok := serveURL([]byte(c.status), "127.0.0.1:7788", hosts)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
