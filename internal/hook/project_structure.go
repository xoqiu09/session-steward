package hook

import (
	"context"
	"encoding/json"
	"time"
)

// ProjectStructure sends one explicit metadata operation, without spooling or retry.
// The server resolves the project through the existing session's WorkItem binding.
func (c *Client) ProjectStructure(ctx context.Context, action, provider, sessionID, cwd, base string, document json.RawMessage) (json.RawMessage, error) {
	body := map[string]any{"provider": provider, "session": sessionID, "host": c.HostID, "cwd": cwd, "base_revision": base, "document": document}
	var out json.RawMessage
	err := c.post(ctx, "/hook/structure/"+action, body, 3*time.Second, &out)
	if err != nil {
		return nil, actionError(err)
	}
	return out, nil
}
