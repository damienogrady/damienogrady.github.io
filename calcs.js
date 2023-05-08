proj4.defs("EPSG:3577","+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs");

function dr_from_longlat(long, lat){
    en = proj4('EPSG:4326','EPSG:3577',[long, lat]);
    loc = en_to_rowcol(en[0],en[1]);
    return deltar(loc[0],loc[1]);
}

function deltar(x,y){
    var dr = 999, sigma = 999;
    if (x > 0 && x < dr_pos.cols && y > 0 && y < dr_pos.rows){
        dr = dr_vals[y][x];
        sigma = sigma_vals[y][x];
    }
	return dr == 999 ? "Out of bounds" : dr + "±" + sigma;
}