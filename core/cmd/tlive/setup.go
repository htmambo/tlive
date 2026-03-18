package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Configure TLive (IM platforms, port, token)",
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println("Setup wizard - TODO")
		return nil
	},
}
