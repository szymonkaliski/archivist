{
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
  let
    systems = [
      "aarch64-darwin"
      "x86_64-darwin"
      "x86_64-linux"
      "aarch64-linux"
    ];
    mkShell = system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib stdenv;
      in
      pkgs.mkShell (
        {
          buildInputs =
            (with pkgs; [
              nodejs_22
              python311
              sqlite
              ffmpeg
            ])
            ++ lib.optionals stdenv.isLinux (with pkgs; [
              chromium
              attr
            ]);
        }
        // lib.optionalAttrs stdenv.isLinux {
          PUPPETEER_SKIP_DOWNLOAD = "true";
          PUPPETEER_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
        }
      );
  in
  {
    devShells = nixpkgs.lib.genAttrs systems (system: {
      default = mkShell system;
    });
  };
}
