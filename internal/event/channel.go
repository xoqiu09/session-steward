package event

// ValidChannel keeps old events readable; an omitted channel means the original hook path.
func ValidChannel(channel string) bool {
	switch channel {
	case "", "hook", "transcript", "process", "git", "github", "hub", "model", "user":
		return true
	}
	return false
}

func Channel(channel string) string {
	if channel == "" {
		return "hook"
	}
	return channel
}

// ChannelPriority resolves equal occurred times, never newer-vs-older observations.
func ChannelPriority(channel string) int {
	switch Channel(channel) {
	case "hook":
		return 3
	case "transcript":
		return 2
	case "process":
		return 1
	}
	return 0
}
