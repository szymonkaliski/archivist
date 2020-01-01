const Fuse = require("fuse.js");
const React = require("react");
const ReactDOM = require("react-dom");
const dateFormat = require("dateformat");
const { chain, identity } = require("lodash");
const { produce } = require("immer");
const { shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
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
  return new Promise(resolve => {
    // running archivist in an interactive shell to support stuff like nvm
    const cmdArgs = [
      "-i",
      "-c",
      ["archivist", ...(args ? [command, args] : [command]), "--json"].join(" ")
    ];

    const process = spawn(SHELL, cmdArgs);
    let result = "";

    process.stdout.on("data", data => {
      result += data.toString();
    });

    process.stderr.on("data", data => {
      console.log("[stderr]", data.toString());
    });

    process.on("exit", () => {
      // sometimes shell leaves some control sequences...
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

    {meta.note && <div className="mb2 lh-copy">{meta.note}</div>}

    {meta.tags && (
      <div>
        {meta.hashtags.map(hashtag => (
          <a
            className="no-underline underline-hover light-gray mr1"
            href="#"
            onClick={() => setSearchText(hashtag)}
          >
            {hashtag}
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
        onMouseEnter={() => {
          setHoveredId(datum.id);
        }}
        onMouseLeave={() => {
          setHoveredId(null);
        }}
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

const getFilteredData = state => {
  if (state.searchText.length > 0) {
    const fuse = new Fuse(state.data, {
      keys: [
        "meta.title",
        "meta.note",
        "meta.hashtags",
        { name: "link", weight: 0.1 },
        { name: "meta.source", weight: 0.1 }
      ],
      shouldSort: false,
      threshold: 0.3
    });

    return fuse.search(state.searchText);
  } else {
    return state.data;
  }
};

const reducer = (state, action) => {
  if (action.type === "SET_DATA") {
    state.data = action.data;
    state.filteredData = getFilteredData(state);
  }

  if (action.type === "SET_IS_SEARCHING") {
    state.isSearching = action.isSearching;
    state.searchText = "";
    state.filteredData = getFilteredData(state);
  }

  if (action.type === "SET_SEARCH_TEXT") {
    state.isSearching = true;
    state.searchText = action.searchText;
    state.filteredData = getFilteredData(state);
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
    filteredData: [],
    searchText: "",
    isSearching: false,
    hoverId: null
  });

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
    executeCLI("query").then(data => {
      const finalData = chain(data)
        .map(d => ({
          ...d,
          time: new Date(d.time),
          meta: {
            ...d.meta,
            hashtags: (d.meta.tags || []).map(tag => `#${tag}`) // so searching by #tag is possible
          }
        }))
        .sortBy(d => d.time)
        .reverse()
        .value();

      dispatch({ type: "SET_DATA", data: finalData });
    });
  }, []);

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
        key={state.searchText + "-" + state.filteredData.length}
        onResize={onResize}
        style={{ outline: "none" }}
      >
        {({ width, height }) =>
          state.filteredData.length > 0 ? (
            <Masonry
              style={{
                padding: SPACER / 2
              }}
              overscanByPixels={300}
              ref={masonry}
              cellCount={state.filteredData.length}
              cellMeasurerCache={cache.current}
              cellPositioner={cellPositioner.current}
              cellRenderer={createCellRenderer({
                data: state.filteredData,
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
