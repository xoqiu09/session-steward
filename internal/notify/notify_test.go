package notify

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
)

func TestScriptEscapesText(t *testing.T) {
	m := &MacOS{}
	s := m.Script(core.Alert{Title: `x" & do shell script "rm`, Body: "a\\b\nc"})
	if strings.Contains(s, `x" & do`) || !strings.Contains(s, `x\" & do shell script \"rm`) || strings.Contains(s, "\nc") {
		t.Fatal(s)
	}
}

func TestDialogOpensDeepLink(t *testing.T) {
	calls := make(chan []string, 4)
	m := &MacOS{Dialog: true, Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls <- append([]string{name}, args...)
		if name == "osascript" {
			return []byte("open\n"), nil
		}
		return nil, nil
	}}
	m.Send(context.Background(), core.Alert{Title: "t", Body: "b", Link: "http://127.0.0.1:7788/#approval=x"})
	<-calls
	select {
	case c := <-calls:
		if c[0] != "open" || c[1] != "http://127.0.0.1:7788/#approval=x" {
			t.Fatal(c)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("点按钮后应打开深链")
	}
}

func TestNtfy(t *testing.T) {
	var title, click, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		title, _ = new(mime.WordDecoder).DecodeHeader(r.Header.Get("Title"))
		click = r.Header.Get("Click")
		b, _ := io.ReadAll(r.Body)
		body = string(b)
	}))
	defer srv.Close()
	if err := (&Ntfy{URL: srv.URL}).Send(context.Background(), core.Alert{Title: "需要你", Body: "STW-1", Link: "http://127.0.0.1/#item=STW-1"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(title, "需要你") || click != "http://127.0.0.1/#item=STW-1" || body != "STW-1" {
		t.Fatal(title, click, body)
	}
	if err := (&Ntfy{}).Send(context.Background(), core.Alert{}); err != nil {
		t.Fatal("未配置时不发送")
	}
}
