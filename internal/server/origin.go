package server

import (
	"net/http"
	"net/url"
	"strings"
)

// requestOriginOK compares the full origin, including its effective port.
// Missing Origin remains supported for authenticated command-line clients.
func requestOriginOK(r *http.Request, remote bool) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	scheme := "http"
	if remote {
		scheme = "https"
	}
	if u.Scheme != scheme {
		return false
	}
	target, err := url.Parse(scheme + "://" + r.Host)
	if err != nil || !strings.EqualFold(u.Hostname(), target.Hostname()) {
		return false
	}
	if !remote && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1" {
		return false
	}
	port := func(v *url.URL) string {
		if p := v.Port(); p != "" {
			return p
		}
		if scheme == "https" {
			return "443"
		}
		return "80"
	}
	return port(u) == port(target)
}
