const Fuse = require("fuse.js");
const React = require("react");
const ReactDOM = require("react-dom");
const { chain, identity } = require("lodash");
const { produce } = require("immer");
const { shell } = require("electron");
const { spawn } = require("child_process");
const { useHotkeys } = require("react-hotkeys-hook");

const {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  createMasonryCellPositioner,
  Masonry
} = require("react-virtualized");

const { useEffect, useCallback, useRef, useReducer } = React;

const SPACER = 10;

const talkToProcess = async (command, args) => {
  return new Promise(resolve => {
    const process = spawn(
      "node",
      args ? ["./process.js", command, args] : ["./process.js", command]
    );

    let data = "";

    process.stdout.on("data", d => {
      data += d.toString();
    });

    process.stderr.on("data", data => {
      console.log("[stderr]", data.toString());
    });

    process.on("exit", () => {
      resolve(JSON.parse(data));
    });
  });
};

const calcColumnWidth = ({ width }) => {
  return width / Math.floor(width / 400) - SPACER;
};

const HoverInfo = ({ meta, link, img }) => (
  <div
    className="absolute bg-dark-gray pa2 f7 white"
    style={{ bottom: 0, left: 0, right: 0 }}
  >
    <a
      className="f6 mb2 lh-title no-underline underline-hover white db"
      href="#"
      onClick={() => link && shell.openExternal(link)}
    >
      {meta.title || link}
    </a>

    {meta.note && <div className="mb2 lh-copy">{meta.note}</div>}

    {meta.tags && (
      <div className="light-gray">{meta.tags.map(t => `#${t}`).join(", ")}</div>
    )}

    <div className="mt2">
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
  </div>
);

const createCellRenderer = ({
  data,
  width,
  cache,
  setHoveredId,
  hoveredId
}) => ({ index, key, parent, style }) => {
  const columnWidth = calcColumnWidth({ width });
  const datum = data[index];

  if (!datum) {
    return null;
  }

  const ratio = datum.height / datum.width;

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
            backgroundImage: `url("${datum.img}")`,
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
            transform: "translateZ(0)"
          }}
        >
          {hoveredId === datum.id && <HoverInfo {...datum} />}
        </div>
      </div>
    </CellMeasurer>
  );
};

const SearchOverlay = ({ searchText, setSearchText, setIsSearching }) => (
  <div
    className="absolute flex pa2 bg-dark-gray white f7 code"
    style={{ left: 0, right: 0, bottom: 0 }}
  >
    <div className="mr2 lh-copy gray">/</div>
    <input
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
);

const getFilteredData = state => {
  if (state.searchText.length > 0) {
    const fuse = new Fuse(state.data, {
      keys: ["link", "meta.title", "meta.note", "meta.tags"],
      shouldSort: true
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

  const masonry = useRef(null);

  useHotkeys(
    "/",
    () => {
      dispatch({ type: "SET_IS_SEARCHING", isSearching: true });
      return false;
    },
    [state.isSearching]
  );

  useHotkeys(
    "esc",
    () => {
      dispatch({ type: "SET_IS_SEARCHING", isSearching: false });
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
    talkToProcess("query").then(data => {
      const finalData = chain(data)
        .map(d => ({ ...d, time: new Date(d.time) }))
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
              style={{ padding: SPACER }}
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
                hoveredId: state.hoverId
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
          searchText={state.setSearchText}
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
const root = ReactDOM.createRoot(rootEl);
root.render(<App />);
