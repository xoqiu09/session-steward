package server

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/xoqiu09/session-steward/internal/conversation"
	"github.com/xoqiu09/session-steward/internal/core"
)

func (s *Server) handleConversation(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil || id <= 0 {
		writeErr(w, core.ErrBadRequest)
		return
	}
	var provider, client, session string
	err = s.Core.St.R().QueryRowContext(r.Context(), `SELECT provider,client,provider_session_id FROM sessions WHERE id=?`, id).Scan(&provider, &client, &session)
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, core.ErrNotFound)
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	home, _ := os.UserHomeDir()
	root := os.Getenv("CLAUDE_CONFIG_DIR")
	if root == "" {
		root = filepath.Join(home, ".claude")
	}
	if strings.HasPrefix(root, "~/") {
		root = filepath.Join(home, strings.TrimPrefix(root, "~/"))
	}
	writeJSON(w, 200, conversation.Resolve(provider, client, session, filepath.Join(root, "sessions")))
}
