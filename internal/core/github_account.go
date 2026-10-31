package core

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/gitx"
)

type repoGitHubAccount struct {
	Repository string `json:"repository"`
	Login      string `json:"login"`
}

var errGitHubAccountUnavailable = errors.New("已保存的 GitHub 账号不可用")

func githubAccountKey(id int64) string { return "merge_account:" + strconv.FormatInt(id, 10) }

func githubTokenEnv(ctx context.Context, bin, login string) ([]string, error) {
	env := []string{"GH_HOST=github.com", "GH_PROMPT_DISABLED=1"}
	if login == "" {
		return env, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "auth", "token", "--hostname", "github.com", "--user", login)
	cmd.Env = append(cmd.Environ(), "GH_PROMPT_DISABLED=1")
	b, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(b)) == "" {
		return nil, errGitHubAccountUnavailable
	}
	return append(env, "GH_TOKEN="+strings.TrimSpace(string(b))), nil
}

func savedGitHubAccounts(ctx context.Context, bin string) []string {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "auth", "status", "--json", "hosts")
	cmd.Env = append(cmd.Environ(), "GH_PROMPT_DISABLED=1")
	b, _ := cmd.Output()
	var data struct {
		Hosts map[string][]struct {
			Login  string `json:"login"`
			Active bool   `json:"active"`
			State  string `json:"state"`
		} `json:"hosts"`
	}
	if json.Unmarshal(b, &data) != nil {
		return nil
	}
	accounts := data.Hosts["github.com"]
	sort.SliceStable(accounts, func(i, j int) bool { return !accounts[i].Active && accounts[j].Active })
	out := []string{}
	for _, a := range accounts {
		if a.Login != "" && a.State == "success" {
			out = append(out, a.Login)
			if len(out) == 8 {
				break
			}
		}
	}
	return out
}

func gitAuthFailure(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	for _, text := range []string{"repository not found", "authentication failed", "could not read username", "access denied", "returned error: 403", "returned error: 401"} {
		if strings.Contains(s, text) {
			return true
		}
	}
	return false
}

// Try only already-signed-in accounts, and only for the configured GitHub repo.
// Selection is repository-local metadata. Tokens stay in child-process memory;
// global gh login, Git configuration and working branches remain untouched.
func (c *Core) fetchMergeRemote(ctx context.Context, r repoRow, remote, remoteURL, ref string) (string, error) {
	fetchArgs := func(source string) []string {
		return []string{"fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance", source, "+" + ref + ":" + remoteMergeRef(r.id)}
	}
	raw, _ := c.St.Meta(ctx, githubAccountKey(r.id))
	var saved repoGitHubAccount
	_ = json.Unmarshal([]byte(raw), &saved)
	full := ""
	bin, _ := exec.LookPath("gh")
	tried := map[string]bool{}
	withAccount := func(login string) error {
		tried[login] = true
		env, err := githubTokenEnv(ctx, bin, login)
		if err != nil {
			return err
		}
		helper := "!'" + strings.ReplaceAll(bin, "'", "'\"'\"'") + "' auth git-credential"
		args := []string{"-c", "credential.helper=", "-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=" + helper, "-c", "credential.https://github.com.username=" + login}
		_, err = gitx.RunEnvTimeout(ctx, r.commonDir, env, gitx.FetchTimeout, append(args, fetchArgs("https://github.com/"+full+".git")...)...)
		return err
	}
	if saved.Login != "" && bin != "" {
		full = resolvedGithubRepository(ctx, remoteURL)
		if full != "" && saved.Repository == full {
			if err := withAccount(saved.Login); err == nil {
				return saved.Login, nil
			} else if !gitAuthFailure(err) && !errors.Is(err, errGitHubAccountUnavailable) {
				return saved.Login, err
			}
		}
	}
	_, originalErr := gitx.RunEnvTimeout(ctx, r.commonDir, nil, gitx.FetchTimeout, fetchArgs(remote)...)
	if originalErr == nil {
		if saved.Login != "" {
			_ = c.St.SetMeta(ctx, githubAccountKey(r.id), "")
		}
		return "", nil
	}
	if !gitAuthFailure(originalErr) || bin == "" {
		return "", originalErr
	}
	if full == "" {
		full = resolvedGithubRepository(ctx, remoteURL)
	}
	if full == "" {
		return "", originalErr
	}
	for _, login := range savedGitHubAccounts(ctx, bin) {
		if tried[login] {
			continue
		}
		if err := withAccount(login); err == nil {
			b, _ := json.Marshal(repoGitHubAccount{Repository: full, Login: login})
			_ = c.St.SetMeta(ctx, githubAccountKey(r.id), string(b))
			return login, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	return "", originalErr
}
