package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	port         int
	shortTimeout int
	longTimeout  int
)

var rootCmd = &cobra.Command{
	Use:   "tlive [command] [args...]",
	Short: "TermLive - Terminal live streaming tool",
	Long:  "Wrap terminal commands for remote monitoring and interaction via Web UI.",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runCommand,
}

func init() {
	rootCmd.Flags().IntVarP(&port, "port", "p", 8080, "Web server port")
	rootCmd.Flags().IntVarP(&shortTimeout, "short-timeout", "s", 30, "Short idle timeout for detected prompts (seconds)")
	rootCmd.Flags().IntVarP(&longTimeout, "long-timeout", "l", 120, "Long idle timeout for unknown idle (seconds)")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
