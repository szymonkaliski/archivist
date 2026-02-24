{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
  let
    mkDarwinShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.mkShell {
      buildInputs = with pkgs; [
        # tauri stuff: https://github.com/tauri-apps/tauri/issues/6612
        cargo
        darwin.apple_sdk.frameworks.AppKit
        darwin.apple_sdk.frameworks.WebKit
        libiconv
        rustc
        rustfmt

        # node for the rest
        nodejs_22
      ];
    };

    mkLinuxShell = system:
    let
      pkgs = nixpkgs.legacyPackages.${system};
    in
    pkgs.mkShell {
      buildInputs = with pkgs; [
        nodejs_22
        chromium
        python311
      ];

      PUPPETEER_SKIP_DOWNLOAD = "true";
      PUPPETEER_EXECUTABLE_PATH = "${pkgs.chromium}/bin/chromium";
    };
  in
  {
    devShells.aarch64-darwin.default = mkDarwinShell "aarch64-darwin";
    devShells.x86_64-darwin.default = mkDarwinShell "x86_64-darwin";
    devShells.x86_64-linux.default = mkLinuxShell "x86_64-linux";
    devShells.aarch64-linux.default = mkLinuxShell "aarch64-linux";
  };
}
