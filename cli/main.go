package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"time"

	"github.com/alecthomas/kong"
	"github.com/chunkzero/maven-r2/internal/api"
	"github.com/chunkzero/maven-r2/internal/client"
	"github.com/chunkzero/maven-r2/internal/config"
	"github.com/chunkzero/maven-r2/internal/proxy"
	"golang.org/x/term"
)

var version = "dev"

type CLI struct {
	Server   string           `help:"Repository server origin." env:"MAVEN_R2_SERVER"`
	Profile  string           `help:"Named login profile." default:"default" env:"MAVEN_R2_PROFILE"`
	Version  kong.VersionFlag `help:"Print version."`
	Login    LoginCmd         `cmd:"" help:"Save an instance URL and a scoped access token."`
	Logout   LogoutCmd        `cmd:"" help:"Remove the selected profile."`
	Profiles ProfilesCmd      `cmd:"" help:"List configured instances."`
	Publish  PublishCmd       `cmd:"" help:"Run Maven or Gradle through a local proxy and commit on success."`
	Serve    ServeCmd         `cmd:"" help:"Serve an explicit publication session on loopback."`
	Session  struct {
		Begin  BeginCmd  `cmd:"" help:"Create a publication session."`
		Status StatusCmd `cmd:"" help:"Inspect a publication."`
		Commit CommitCmd `cmd:"" help:"Validate and publish a completed session."`
		Abort  AbortCmd  `cmd:"" help:"Discard an unpublished session."`
	} `cmd:"" help:"Manage explicit publication sessions."`
}

func main() {
	var cli CLI
	ctx := kong.Parse(&cli, kong.Name("maven-r2"), kong.Description("Publish Maven artifacts to Cloudflare R2."), kong.Vars{"version": version})
	if err := ctx.Run(&cli); err != nil {
		fmt.Fprintln(os.Stderr, "maven-r2:", err)
		var child *exec.ExitError
		if errors.As(err, &child) && child.ExitCode() > 0 {
			os.Exit(child.ExitCode())
		}
		os.Exit(1)
	}
}

func (cli *CLI) client() (*client.Client, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	profile := cfg.Profiles[cli.Profile]
	if cli.Server != "" {
		profile.Server = cli.Server
	}
	if token := os.Getenv("MAVEN_R2_TOKEN"); token != "" {
		profile.Token = token
	}
	return client.New(profile.Server, profile.Token)
}

type LoginCmd struct {
	TokenStdin bool `help:"Read the token from standard input (for automation)."`
}

func (cmd *LoginCmd) Run(cli *CLI) error {
	server, err := config.ValidateServer(cli.Server)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Create a scoped token in the web console:", server+"/tokens")
	var token string
	if cmd.TokenStdin {
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			token = scanner.Text()
		}
		if err = scanner.Err(); err != nil {
			return err
		}
	} else {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return fmt.Errorf("use --token-stdin for non-interactive login, or set MAVEN_R2_TOKEN")
		}
		fmt.Fprint(os.Stderr, "Access token: ")
		raw, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		if err != nil {
			return err
		}
		token = string(raw)
	}
	token = strings.TrimSpace(token)
	if !strings.HasPrefix(token, "mr2_") {
		return fmt.Errorf("expected a Maven R2 access token")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cfg.Profiles[cli.Profile] = config.Profile{Server: server, Token: token}
	if err = config.Save(cfg); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Saved profile", cli.Profile)
	return nil
}

type LogoutCmd struct{}

func (*LogoutCmd) Run(cli *CLI) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	delete(cfg.Profiles, cli.Profile)
	return config.Save(cfg)
}

type ProfilesCmd struct{}

func (*ProfilesCmd) Run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	for name, profile := range cfg.Profiles {
		fmt.Printf("%s\t%s\n", name, profile.Server)
	}
	return nil
}

type RepositoryFlags struct {
	Repository string `required:"" help:"Account/repository, for example acme/releases."`
	Label      string `help:"Label shown in publication history."`
}

func (flags RepositoryFlags) begin(ctx context.Context, c *client.Client) (api.Publication, error) {
	parts := strings.Split(flags.Repository, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return api.Publication{}, fmt.Errorf("repository must be account/repository")
	}
	return c.Begin(ctx, parts[0], parts[1], flags.Label)
}

type PublishCmd struct {
	RepositoryFlags `embed:""`
	Session         string   `help:"Resume an existing open publication instead of creating one."`
	KeepOnFailure   bool     `help:"Keep staged files if the build fails, for inspection or manual commit."`
	MaxFileBytes    int64    `default:"2147483648" help:"Maximum bytes spooled per file."`
	Command         []string `arg:"" required:"" passthrough:"" help:"Build command after --."`
}

func (cmd *PublishCmd) Run(cli *CLI) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	c, err := cli.client()
	if err != nil {
		return err
	}
	var publication api.Publication
	if cmd.Session != "" {
		publication, err = c.Status(ctx, cmd.Session)
	} else {
		publication, err = cmd.RepositoryFlags.begin(ctx, c)
	}
	if err != nil {
		return err
	}
	if publication.Status != api.PublicationStatusOpen {
		return fmt.Errorf("publication is %s", publication.Status)
	}
	logger := log.New(os.Stderr, "maven-r2: ", 0)
	local := &proxy.Server{Client: c, Session: publication.Id, MaxFileBytes: cmd.MaxFileBytes, Log: logger}
	if err = local.Start(); err != nil {
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		local.Close(shutdown)
	}()
	logger.Printf("publication %s", publication.Id)
	child := exec.CommandContext(ctx, cmd.Command[0], cmd.Command[1:]...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.WaitDelay = 5 * time.Second
	child.Env = buildEnvironment(local)
	err = child.Run()
	if err == nil {
		err = local.Failure()
	}
	if err != nil {
		if cmd.KeepOnFailure {
			logger.Printf("kept publication %s; resume it or use session abort", publication.Id)
		} else {
			abortCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if abortErr := c.Abort(abortCtx, publication.Id); abortErr != nil {
				logger.Printf("could not abort %s: %v", publication.Id, abortErr)
			}
		}
		return fmt.Errorf("build did not publish: %w", err)
	}
	if _, err = c.Commit(ctx, publication.Id); err != nil {
		return fmt.Errorf("finalization failed for %s; retry with session commit %s: %w", publication.Id, publication.Id, err)
	}
	logger.Printf("published %s", publication.Id)
	return nil
}

func buildEnvironment(local *proxy.Server) []string {
	env := make([]string, 0, len(os.Environ())+4)
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "MAVEN_R2_TOKEN", "MAVEN_R2_URL", "MAVEN_R2_USERNAME", "MAVEN_R2_PASSWORD", "MAVEN_R2_SESSION":
			continue
		}
		env = append(env, entry)
	}
	return append(env, "MAVEN_R2_URL="+local.URL, "MAVEN_R2_USERNAME=maven-r2", "MAVEN_R2_PASSWORD="+local.Password, "MAVEN_R2_SESSION="+local.Session)
}

type ServeCmd struct {
	Session      string `required:"" help:"Open session ID from session begin."`
	EnvFile      string `required:"" help:"Write local credentials to this file with owner-only permissions."`
	MaxFileBytes int64  `default:"2147483648"`
}

func (cmd *ServeCmd) Run(cli *CLI) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	c, err := cli.client()
	if err != nil {
		return err
	}
	publication, err := c.Status(ctx, cmd.Session)
	if err != nil {
		return err
	}
	if publication.Status != api.PublicationStatusOpen {
		return fmt.Errorf("publication is %s", publication.Status)
	}
	local := &proxy.Server{Client: c, Session: cmd.Session, MaxFileBytes: cmd.MaxFileBytes, Log: log.New(os.Stderr, "maven-r2: ", 0)}
	if err = local.Start(); err != nil {
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		local.Close(shutdown)
	}()
	file, err := os.OpenFile(cmd.EnvFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer os.Remove(cmd.EnvFile)
	_, err = fmt.Fprintf(file, "MAVEN_R2_URL=%s\nMAVEN_R2_USERNAME=maven-r2\nMAVEN_R2_PASSWORD=%s\nMAVEN_R2_SESSION=%s\n", local.URL, local.Password, local.Session)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	fmt.Fprintf(os.Stderr, "Proxy ready at %s. Credentials: %s. Commit the session explicitly after publishing.\n", local.URL, cmd.EnvFile)
	<-ctx.Done()
	return nil
}

type BeginCmd struct {
	RepositoryFlags `embed:""`
}

func (cmd *BeginCmd) Run(cli *CLI) error {
	c, err := cli.client()
	if err != nil {
		return err
	}
	p, err := cmd.begin(context.Background(), c)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(p)
}

type StatusCmd struct {
	ID string `arg:"" required:""`
}

func (cmd *StatusCmd) Run(cli *CLI) error {
	c, err := cli.client()
	if err != nil {
		return err
	}
	p, err := c.Status(context.Background(), cmd.ID)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(p)
}

type CommitCmd struct {
	ID string `arg:"" required:""`
}

func (cmd *CommitCmd) Run(cli *CLI) error {
	c, err := cli.client()
	if err != nil {
		return err
	}
	p, err := c.Commit(context.Background(), cmd.ID)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(p)
}

type AbortCmd struct {
	ID string `arg:"" required:""`
}

func (cmd *AbortCmd) Run(cli *CLI) error {
	c, err := cli.client()
	if err != nil {
		return err
	}
	return c.Abort(context.Background(), cmd.ID)
}
