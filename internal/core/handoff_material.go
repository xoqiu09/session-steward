package core

import (
	"fmt"
	"sort"
	"strings"
)

// 每个会话分别保留卡点和下一步，不能只把最后发言者当作整个工作项。
func appendSessionMaterial(b *strings.Builder, w *WorkItem) {
	if w.Brief == nil || len(w.Brief.BySession) == 0 {
		return
	}
	keys := make([]int64, 0, len(w.Brief.BySession))
	for k := range w.Brief.BySession {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	fmt.Fprintln(b, "\n## 各会话回报（彼此不覆盖）")
	for _, k := range keys {
		fmt.Fprintf(b, "### 会话 #%d\n", k)
		for _, field := range BriefFields {
			if v := w.Brief.BySession[k].Fields[field]; v != nil && v.Text != "" {
				fmt.Fprintf(b, "- %s：%s（%s，%s）\n", field, v.Text, v.Kind, v.At)
			}
		}
	}
}
