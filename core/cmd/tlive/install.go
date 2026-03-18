package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Install TLive components",
}

var installSkillsCmd = &cobra.Command{
	Use:   "skills",
	Short: "Install /tlive skill to Claude Code or Codex",
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Println("Install skills - TODO")
		return nil
	},
}

func init() {
	installCmd.AddCommand(installSkillsCmd)
}
