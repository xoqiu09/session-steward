package core

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// WorkManagement records an explicit panel user's disposition, separately from
// Agent execution, Git merge proof and feature acceptance.
type WorkManagement struct {
	State string `json:"state"`
	Owner string `json:"owner,omitempty"`
	Note  string `json:"note,omitempty"`
	At    string `json:"at"`
}

func managementKey(id string) string { return "work_management:" + id }

func validateManagement(m *WorkManagement) error {
	if m == nil {
		return nil
	}
	m.Owner = strings.TrimSpace(m.Owner)
	m.Note = strings.TrimSpace(m.Note)
	if len([]rune(m.Owner)) > 80 || len([]rune(m.Note)) > 500 {
		return fmt.Errorf("%w: 接手人最多 80 字，说明最多 500 字", ErrBadRequest)
	}
	if m.State != "accepted" && m.State != "active" && m.State != "paused" && m.State != "delegated" {
		return fmt.Errorf("%w: 未知的管理状态", ErrBadRequest)
	}
	if m.State == "delegated" && m.Owner == "" {
		return fmt.Errorf("%w: 请填写接手人或接手会话", ErrBadRequest)
	}
	return nil
}

func writeManagement(tx *sql.Tx, id, now string, m *WorkManagement) error {
	if m == nil {
		return nil
	}
	m.At = now
	if m.State == "active" {
		if _, err := tx.Exec(`DELETE FROM meta WHERE k=?`, managementKey(id)); err != nil {
			return err
		}
		fields := []struct{ key, text string }{{"stage", "implementing"}, {"next_owner", "agent"}}
		if m.Note != "" {
			fields = append(fields, struct{ key, text string }{"next", m.Note})
		}
		for _, field := range fields {
			source := "user"
			if field.key == "stage" {
				source = "reopened"
			}
			if _, err := tx.Exec(`INSERT INTO brief_entries(work_item_id,field,text,kind,source,at,created_at) VALUES(?,?,?,'user',?,?,?)`, id, field.key, field.text, source, now, now); err != nil {
				return err
			}
		}
	} else {
		b, _ := json.Marshal(m)
		if _, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, managementKey(id), string(b)); err != nil {
			return err
		}
	}
	text := map[string]string{"accepted": "用户标记已验收", "active": "用户选择继续处理", "paused": "用户暂停此工作项的日常提醒", "delegated": "用户记录已转交给 " + m.Owner}[m.State]
	if m.Note != "" {
		text += "：" + m.Note
	}
	_, err := tx.Exec(`INSERT INTO brief_entries(work_item_id,field,text,kind,source,at,created_at) VALUES(?,'management',?,'user','management',?,?)`, id, text, now, now)
	return err
}
