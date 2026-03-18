package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/termlive/termlive/core/internal/daemon"
)

var stopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the TLive daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		lockPath := daemon.DefaultLockPath()
		lock, err := daemon.ReadLockFile(lockPath)
		if err != nil {
			return fmt.Errorf("no running daemon found")
		}
		// Kill the process
		p, err := os.FindProcess(lock.Pid)
		if err != nil {
			return fmt.Errorf("cannot find process %d", lock.Pid)
		}
		if err := p.Signal(os.Interrupt); err != nil {
			return fmt.Errorf("cannot stop daemon: %v", err)
		}
		fmt.Fprintf(os.Stderr, "Daemon stopped (PID %d)\n", lock.Pid)
		return nil
	},
}
