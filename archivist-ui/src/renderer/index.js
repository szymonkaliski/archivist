const React = require("react");
const ReactDOM = require("react-dom");
const dateFormat = require("dateformat");
const strip = require("strip");
const { chain, identity } = require("lodash");
const { produce } = require("immer");
const { shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { useDebounce } = require("use-debounce");
const { useHotkeys } = require("react-hotkeys-hook");

const {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  createMasonryCellPositioner,
  Masonry
} = require("react-virtualized");

require("tachyons/src/tachyons.css");
require("react-virtualized/styles.css");

const { useEffect, useCallback, useRef, useReducer } = React;

const SPACER = 10;
const SHELL = process.env.SHELL || "bash";

// running archivist in an interactive shell to support stuff like nvm
const HAS_ARCHIVIST = !spawnSync(SHELL, ["-i", "-c", "archivist"]).error;

const executeCLI = async (command, args) => {
  return new Promise((resolve, reject) => {
    // running archivist in an interactive shell to support stuff like nvm
    const cmdArgs = [
      "-i",
      "-c",
      ["archivist", command, args, "--json"].filter(identity).join(" ")
    ];

    const process = spawn(SHELL, cmdArgs);
    let result = "";

    process.stdout.on("data", data => {
      result += data.toString();
    });

    process.stderr.on("data", data => {
      reject(data);
    });

    process.on("exit", () => {
      // sometimes shell leaves control sequences...
      const clean = result.replace(/^.*\[/, "[");
      resolve(JSON.parse(clean));
    });
  });
};

const calcColumnWidth = ({ width }) => {
  return width / Math.floor(width / 400) - SPACER;
};

const HoverInfo = ({ meta, link, img, time, setSearchText }) => (
  <div
    className="absolute bg-dark-gray pa2 f7 white w-100"
    style={{ bottom: 0, left: 0, right: 0 }}
  >
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
        {meta.tags.map(tag => (
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
          ["img", () => shell.openItem(img)]
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

const createCellRenderer = ({
  data,
  width,
  cache,
  setHoveredId,
  hoveredId,
  setSearchText
}) => ({ index, key, parent, style }) => {
  const columnWidth = calcColumnWidth({ width });
  const datum = data[index] || {};
  const ratio = datum.height / datum.width;
  const imgPath = datum.img;

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
            backgroundImage: `url("file:${imgPath}")`,
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            transform: "translateZ(0)"
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
        onChange={e => setSearchText(e.target.value)}
        onKeyDown={e => {
          // escape
          if (e.keyCode === 27) {
            setIsSearching(false);
          }
        }}
      />
    </div>
  )
);

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
    hoverId: null
  });

  const [debouncedSearchText] = useDebounce(state.searchText, 30);

  const searchInputRef = useRef(null);
  const masonry = useRef(null);

  useHotkeys(
    "/",
    () => {
      if (!state.isSearching) {
        dispatch({ type: "SET_IS_SEARCHING", isSearching: true });
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
      fixedWidth: true
    })
  );

  const cellPositioner = useRef(
    createMasonryCellPositioner({
      cellMeasurerCache: cache.current,
      columnCount: 3,
      columnWidth: 400,
      spacer: SPACER
    })
  );

  useEffect(() => {
    executeCLI("query", debouncedSearchText)
      .then(data => {
        const finalData = chain(data)
          .map(d => ({
            ...d,
            time: new Date(d.time)
          }))
          .sortBy(d => d.time)
          .reverse()
          .value();

        dispatch({ type: "SET_DATA", data: finalData });
      })
      .catch(e => {
        console.error("archivist-cli error", e);
      });
  }, [debouncedSearchText]);

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
          spacer: SPACER
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
        key={debouncedSearchText + "-" + state.data.length}
        onResize={onResize}
        style={{ outline: "none" }}
      >
        {({ width, height }) =>
          state.data.length > 0 ? (
            <Masonry
              style={{
                padding: SPACER / 2
              }}
              overscanByPixels={300}
              ref={masonry}
              cellCount={state.data.length}
              cellMeasurerCache={cache.current}
              cellPositioner={cellPositioner.current}
              cellRenderer={createCellRenderer({
                data: state.data,
                width,
                cache,
                setHoveredId: hoverId =>
                  dispatch({ type: "SET_HOVER_ID", hoverId }),
                hoveredId: state.hoverId,
                setSearchText: searchText => {
                  dispatch({ type: "SET_SEARCH_TEXT", searchText });
                }
              })}
              width={width}
              height={height}
            />
          ) : (
            <div />
          )
        }
      </AutoSizer>

      {state.isSearching && (
        <SearchOverlay
          ref={searchInputRef}
          searchText={state.searchText}
          setIsSearching={isSearching =>
            dispatch({ type: "SET_IS_SEARCHING", isSearching })
          }
          setSearchText={searchText =>
            dispatch({ type: "SET_SEARCH_TEXT", searchText })
          }
        />
      )}
    </div>
  );
};

const rootEl = document.getElementById("app");
ReactDOM.render(<App />, rootEl);
