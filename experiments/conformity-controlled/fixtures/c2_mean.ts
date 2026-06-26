// c2_mean.ts -- same algorithm as c1, different identifier names + formatting.
export function average( values : number[] ) : number
{
    let total = 0 ;

    for ( let idx = 0 ; idx < values.length ; idx++ )
    {
        total = total + values[ idx ] ;
    }

    return total / values.length ;
}
