const React = require("react");
const ReactDOM = require("react-dom");
const dateFormat = require("dateformat");
const strip = require("strip");
const { chain, identity } = require("lodash");
const { produce } = require("immer");
const { shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { useThrottle } = require("use-throttle");
const { useHotkeys } = require("react-hotkeys-hook");

const {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  createMasonryCellPositioner,
  Grid,
  Masonry,
} = require("react-virtualized");

require("tachyons/src/tachyons.css");
require("react-virtualized/styles.css");

const { useEffect, useCallback, useRef, useReducer } = React;

const SHELL = process.env.SHELL || "bash";
const SPACER = 10;
const THROTTLE_TIME = 100;

const USE_MASONRY = false;
const USE_GRID = true;

// running archivist in an interactive shell to support stuff like nvm
const HAS_ARCHIVIST = !spawnSync(SHELL, ["-i", "-c", "archivist"]).error;

const executeCLI = async (command, args) => {
  return new Promise((resolve, reject) => {
    // running archivist in an interactive shell to support stuff like nvm
    const cmdArgs = [
      "-i",
      "-c",
      ["archivist", command, args, "--json"].filter(identity).join(" "),
    ];

    const process = spawn(SHELL, cmdArgs);
    let result = "";

    process.stdout.on("data", (data) => {
      result += data.toString();
    });

    process.stderr.on("data", (data) => {
      // we can have stderr AND data at the same time, this shouldn't reject the results completely...
      // reject(data);
    });

    process.on("exit", () => {
      // sometimes shell leaves control sequences...
      const clean = result.replace(/^.*\[/, "[");
      resolve(JSON.parse(clean));
    });
  });
};

const calcColumnWidth = ({ width }) => {
  return width / Math.floor(width / 400);
};

const Info = ({ meta, link, img, time, setSearchText }) => {
  return (
    <div>
      <a
        className="mb2 db f6 lh-title no-underline underline-hover white word-wrap truncate"
        href="#"
        onClick={() => link && shell.openExternal(link)}
      >
        {meta.title || link}
      </a>

      {meta.note && <div className="mb2 lh-copy">{strip(meta.note)}</div>}

      {meta.tags && (
        <div>
          {meta.tags.map((tag) => (
            <a
              key={tag}
              className="no-underline underline-hover light-gray mr1"
              href="#"
              onClick={() => setSearchText(tag)}
            >
              {tag}
            </a>
          ))}
        </div>
      )}

      <div className="mt2 flex justify-between items-center">
        <div>
          {[
            link && ["src", () => shell.openExternal(link)],
            meta.static && ["frozen", () => shell.openItem(meta.static)],
            ["img", () => shell.openItem(img)],
          ]
            .filter(identity)
            .map(([text, callback]) => (
              <a
                key={text}
                className="link dim br2 ph2 pv1 dib white bg-mid-gray mr1"
                href="#"
                onClick={callback}
              >
                {text}
              </a>
            ))}
        </div>
        <div className="tr gray">
          {meta.source} / {dateFormat(time, "yyyy-mm-dd")}
        </div>
      </div>
    </div>
  );
};

const HoverInfo = ({ ...props }) => (
  <div
    className="absolute bg-dark-gray pa2 f7 white w-100"
    style={{ bottom: 0, left: 0, right: 0 }}
  >
    <Info {...props} />
  </div>
);

const createMasonryCellRenderer = ({
  data,
  width,
  cache,
  setHoveredId,
  hoveredId,
  setSearchText,
}) => ({ index, key, parent, style }) => {
  const columnWidth = calcColumnWidth({ width }) - SPACER;
  const datum = data[index] || {};
  const ratio = datum.height / datum.width;

  return (
    <CellMeasurer cache={cache.current} index={index} key={key} parent={parent}>
      <div
        style={style}
        className="h-100"
        onMouseEnter={() => setHoveredId(datum.id)}
        onMouseLeave={() => setHoveredId(null)}
      >
        <div
          className="h-100 relative"
          style={{
            height: ratio * columnWidth,
            width: columnWidth,
            backgroundImage: `url("file:${datum.img}")`,
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            transform: "translateZ(0)",
          }}
        >
          {hoveredId === datum.id && (
            <HoverInfo setSearchText={setSearchText} {...datum} />
          )}
        </div>
      </div>
    </CellMeasurer>
  );
};

const SearchOverlay = React.forwardRef(
  ({ searchText, setSearchText, setIsSearching }, ref) => (
    <div
      className="absolute flex pa2 bg-dark-gray white f7 code"
      style={{ left: 0, right: 0, bottom: 0 }}
    >
      <div className="mr2 lh-copy gray">/</div>
      <input
        ref={ref}
        className="w-100 bg-dark-gray white outline-0 bw0 lh-copy"
        autoFocus={true}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        onKeyDown={(e) => {
          // escape
          if (e.keyCode === 27) {
            setIsSearching(false);
          }
        }}
      />
    </div>
  )
);

const createGridCellRenderer = ({
  data,
  setHoveredId,
  hoveredId,
  setSearchText,
  columnCount,
}) => ({ columnIndex, rowIndex, key, parent, style }) => {
  const index = rowIndex * columnCount + columnIndex;
  const datum = data[index];

  if (!datum) {
    return null;
  }

  return (
    <div
      style={style}
      className="h-100 pa1"
      onMouseEnter={() => setHoveredId(datum.id)}
      onMouseLeave={() => setHoveredId(null)}
    >
        <div
          className="h-100 relative"
          style={{
            backgroundImage: `url("file:${datum.img}")`,
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            transform: "translateZ(0)",
          }}
        >
          {hoveredId === datum.id && (
            <HoverInfo setSearchText={setSearchText} {...datum} />
          )}
        </div>
    </div>
  );
};

const GridWrapper = ({
  data,
  width,
  height,
  setHoveredId,
  hoveredId,
  setSearchText,
}) => {
  const columnWidth = calcColumnWidth({ width });
  const columnCount = Math.round(width / columnWidth);
  const rowCount = Math.ceil(data.length / columnCount);

  return (
    <Grid
      cellRenderer={createGridCellRenderer({
        data,
        setHoveredId,
        hoveredId,
        setSearchText,
        columnCount,
      })}
      height={height}
      width={width}
      columnCount={columnCount}
      columnWidth={columnWidth}
      rowCount={rowCount}
      rowHeight={columnWidth}
    />
  );
};

const reducer = (state, action) => {
  if (action.type === "SET_DATA") {
    state.data = action.data;
  }

  if (action.type === "SET_IS_SEARCHING") {
    state.isSearching = action.isSearching;
    state.searchText = "";
  }

  if (action.type === "SET_SEARCH_TEXT") {
    state.isSearching = true;
    state.searchText = action.searchText;
  }

  if (action.type === "SET_HOVER_ID") {
    state.hoverId = action.hoverId;
  }

  return state;
};

const immutableReducer = produce(reducer);

const App = () => {
  const [state, dispatch] = useReducer(immutableReducer, {
    data: [],
    searchText: "",
    isSearching: false,
    hoverId: null,
  });

  const lastEntry = useRef("");
  const throttledSearchText = useThrottle(state.searchText, THROTTLE_TIME);

  const searchInputRef = useRef(null);
  const masonry = useRef(null);

  useHotkeys(
    "/",
    (e) => {
      if (!state.isSearching) {
        // otherwise `/` ends up in text input
        setTimeout(() => {
          dispatch({ type: "SET_IS_SEARCHING", isSearching: true });
        }, 0);
      } else if (searchInputRef.current) {
        searchInputRef.current.focus();
      }

      return false;
    },
    [state.isSearching]
  );

  useHotkeys(
    "esc",
    () => {
      if (state.isSearching) {
        dispatch({ type: "SET_IS_SEARCHING", isSearching: false });
      }

      return false;
    },
    [state.isSearching]
  );

  const cache = useRef(
    new CellMeasurerCache({
      defaultHeight: 400,
      defaultWidth: 400,
      fixedWidth: true,
    })
  );

  const cellPositioner = useRef(
    createMasonryCellPositioner({
      cellMeasurerCache: cache.current,
      columnCount: 3,
      columnWidth: 400,
      spacer: SPACER,
    })
  );

  useEffect(() => {
    lastEntry.current = throttledSearchText;

    executeCLI(
      "search",
      throttledSearchText && throttledSearchText.length > 3
        ? `"${throttledSearchText}"`
        : undefined
    )
      .then((data) => {
        if (lastEntry.current !== throttledSearchText) {
          return;
        }

        const finalData = chain(data)
          .map((d) => ({
            ...d,
            time: new Date(d.time),
          }))
          .sortBy((d) => d.time)
          .reverse()
          .value();

        dispatch({ type: "SET_DATA", data: finalData });
      })
      .catch((e) => {
        console.error("archivist-cli error", e.toString());
      });
  }, [throttledSearchText]);

  const onResize = useCallback(
    ({ width }) => {
      const columnWidth = calcColumnWidth({ width });
      const columnCount = Math.floor(Math.max(width / columnWidth, 1));

      if (cache.current) {
        cache.current.clearAll();
      }

      if (cellPositioner.current) {
        cellPositioner.current.reset({
          columnCount,
          columnWidth,
          spacer: SPACER,
        });
      }

      if (masonry.current) {
        masonry.current.clearCellPositions();
      }
    },
    [cache, cellPositioner, masonry]
  );

  if (!HAS_ARCHIVIST) {
    return (
      <div className="sans-serif w-100 vh-100 bg-light-gray code red pa4 f6">
        Error: archivist cli tool not found
      </div>
    );
  }

  return (
    <div className="sans-serif w-100 vh-100 bg-light-gray">
      <AutoSizer
        key={throttledSearchText + "-" + state.data.length}
        onResize={onResize}
        style={{ outline: "none" }}
      >
        {({ width, height }) =>
          state.data.length > 0 && (
            <>
              {USE_MASONRY && (
                <Masonry
                  style={{ padding: SPACER / 2 }}
                  overscanByPixels={300}
                  ref={masonry}
                  cellCount={state.data.length}
                  cellMeasurerCache={cache.current}
                  cellPositioner={cellPositioner.current}
                  cellRenderer={createMasonryCellRenderer({
                    data: state.data,
                    width,
                    cache,
                    setHoveredId: (hoverId) =>
                      dispatch({ type: "SET_HOVER_ID", hoverId }),
                    hoveredId: state.hoverId,
                    setSearchText: (searchText) => {
                      dispatch({ type: "SET_SEARCH_TEXT", searchText });
                    },
                  })}
                  width={width}
                  height={height}
                />
              )}

              {USE_GRID && (
                <GridWrapper
                  data={state.data}
                  height={height}
                  width={width}
                  setHoveredId={(hoverId) =>
                    dispatch({ type: "SET_HOVER_ID", hoverId })
                  }
                  hoveredId={state.hoverId}
                  setSearchText={(searchText) => {
                    dispatch({ type: "SET_SEARCH_TEXT", searchText });
                  }}
                />
              )}
            </>
          )
        }
      </AutoSizer>

      {state.isSearching && (
        <SearchOverlay
          ref={searchInputRef}
          searchText={state.searchText}
          setIsSearching={(isSearching) =>
            dispatch({ type: "SET_IS_SEARCHING", isSearching })
          }
          setSearchText={(searchText) =>
            dispatch({ type: "SET_SEARCH_TEXT", searchText })
          }
        />
      )}
    </div>
  );
};

const rootEl = document.getElementById("app");
ReactDOM.render(<App />, rootEl);
